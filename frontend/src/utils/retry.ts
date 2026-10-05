/**
 * 单摊留底写入保护
 * 两摊各自留底、不改对方那份：写入失败后只对「自己这张表」重试，
 * 调用方绝不应在此之后回滚或改写对方表。
 * 纯前端 IndexedDB：瞬时失败（配额 / 事务中断 / 隐私模式）下重试本摊写入。
 */

/** 默认可重试的尝试次数（含首次） */
export const DEFAULT_WRITE_RETRIES = 3;

/** 两次尝试之间的退避（毫秒） */
function backoffDelay(attempt: number): number {
  return 60 * attempt;
}

/**
 * 执行一次只影响本方留底的写入；失败时仅重试同一个写入动作。
 * @param write 只写自己那张表的异步动作（不得在内部改写对方那份）
 * @param label 本方留底名称，用于错误文案
 * @param retries 总尝试次数
 */
export async function retryOwnWrite<T>(
  write: () => Promise<T>,
  label = '本方留底',
  retries: number = DEFAULT_WRITE_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)));
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label}写入失败，已重试 ${retries} 次仍未成功，对方那份未受影响：${reason}`);
}
