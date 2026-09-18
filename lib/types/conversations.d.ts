/**
 * AGY 续接记录的持久化:dsh 会话 id → AGY conversationId + 发送锚点。
 *
 * 服务重启后凭此继续 `--conversation` 续跑,而不是把整个 dsh 历史当新任务
 * 全量重发(实测:历史含大任务书与长工具输出时可达 1.2MB,AGY 每次先读
 * 巨型 agy-task 临时文件再干活,token 开销与耗时都不可接受)。
 * 结构与 dsh-subagent-codebuddy 的 ConversationStore 同源。
 * @module llm-agy/conversations
 */
/** 一条续接记录。 */
export interface AgyConversationRecord {
    /** AGY 服务端会话 id(--conversation 恢复用)。 */
    conversationId: string;
    /** 旧数量锚:上次发送时 dsh 消息总数。 */
    sentCount: number;
    /** 主锚:上次发送覆盖到的最后一条 dsh 消息 id。 */
    lastSentMessageId?: string;
    /** 最后使用时间(逐出排序用)。 */
    at: number;
}
/** 持久化的续接映射(纯内存模式用于测试:file = null)。 */
export declare class ConversationStore {
    private readonly file;
    private readonly map;
    private saveTimer;
    /**
     * @param file - 存储文件路径;`null` 为纯内存(测试用)。
     */
    constructor(file?: string | null);
    /** 读取会话的续接记录。 */
    get(sessionId: string): AgyConversationRecord | undefined;
    /** 写入/更新续接记录(自动落盘)。 */
    set(sessionId: string, record: {
        conversationId: string;
        sentCount: number;
        lastSentMessageId?: string;
    }): void;
    /** 删除会话记录(如 AGY 侧会话失效时)。 */
    delete(sessionId: string): void;
    private load;
    private scheduleSave;
    private saveNow;
}
