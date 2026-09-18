/**
 * 序列化模块:把 harness GenerateOptions 翻译为 AGY 单轮 prompt。
 * 对齐 llm-deepseek/serialize.ts 的职责:请求 → 上游格式。
 * - 系统提示、对话消息按顺序拼接;
 * - 图片块落盘为临时文件,在 prompt 中给出本地路径(AGY 自行读取看图);
 * - 超长 prompt 写入临时文件,命令行只给短引用(Windows 命令行 32K 限制)。
 * @module llm-agy/serialize
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
/** mediaType → 临时文件扩展名。 */
const IMAGE_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};
/** 长 prompt 转临时文件引用的阈值(Windows 命令行 32K 上限,留足余量)。 */
const FILE_REF_THRESHOLD = 26_000;
/**
 * 运行时约束:AGY 每次调用都是一个一次性 print 进程,回合结束进程即终止,
 * 交互模式里"后台任务完成后再唤醒继续"的循环不存在。实测 AGY 用 Bash
 * run_in_background 启动 Playwright 后立即输出"已在后台启动,完成后继续"
 * 并结束回合——后台任务的结果永远等不到,子代理对话随之提前收尾。
 * 每次 stream() 都是新进程,因此每次 prompt 都必须带上。
 */
const RUNTIME_CONSTRAINTS = [
    '运行环境约束(必须遵守):',
    '- 你处于非交互一次性调用:你的回合结束后本次调用立即终止,不存在"后台任务完成后再唤醒你"的机制。',
    '- 禁止用 Bash 后台/异步方式(run_in_background、Start-Job 等)启动你后续还需要其结果的命令——你永远收不到它的完成通知。',
    '- 需要结果的命令(构建/测试/截图/检查等)一律前台运行并耐心等待完成,拿到结果后再继续下一步。',
    '- 唯一例外:常驻服务进程(如 dev server)可以后台拉起,但必须在同一回合内自行轮询就绪并完成验证,不能启动后等待通知。',
    '- 全部工作真正完成后才输出最终总结;确实无法继续时,明确说明阻塞原因后结束。',
].join('\n');
/** 多轮延续说明:明确历史与新指令的边界,防止 AGY 把历史记录当新任务从头重跑(实测)。 */
const CONTINUATION_NOTE = '注意:这是同一任务的延续。以下 User/Assistant 交替内容是先前会话的历史记录,仅供了解已完成的工作;'
    + '不要重做已完成的部分,也不要把历史里的内容当作待办任务;只执行最后一条 User 消息。';
/** 把 harness 消息序列化为 AGY 单轮 prompt;图片落盘为临时路径。 */
export async function buildPrompt(ctx, options) {
    const parts = [];
    if (options.system !== undefined && options.system.length > 0) {
        parts.push(`System instructions:\n${options.system}`);
    }
    parts.push(RUNTIME_CONSTRAINTS);
    // 首轮任务只有一条消息;历史多于一条说明是续跑/延续。
    if (options.messages.length > 1) {
        parts.push(CONTINUATION_NOTE);
    }
    const tempFiles = [];
    const attachments = ctx.get('attachments');
    for (const message of options.messages) {
        const text = message.content
            .filter((block) => block.type === 'text')
            .map(block => block.text)
            .join('');
        const images = message.content.filter(block => block.type === 'image');
        const notePaths = [];
        if (images.length > 0 && attachments !== undefined) {
            for (const block of images) {
                if (block.type !== 'image')
                    continue;
                try {
                    const stored = await attachments.readImage(block.attachment);
                    const ext = IMAGE_EXT[stored.ref.mediaType] ?? 'img';
                    const file = join(tmpdir(), `agy-${randomUUID()}.${ext}`);
                    await writeFile(file, stored.data);
                    tempFiles.push(file);
                    notePaths.push(file);
                }
                catch {
                    // 附件不可读则跳过该图。
                }
            }
        }
        const label = message.role === 'assistant' ? 'Assistant' : 'User';
        const note = notePaths.length > 0
            ? `\n[附带图片,请读取以下本地路径查看:${notePaths.join(', ')}]`
            : '';
        parts.push(`${label}: ${text}${note}`);
    }
    let prompt = parts.join('\n\n');
    // 超长 prompt 写入临时文件,命令行只给短引用(AGY 会自己读取文件)。
    if (prompt.length > FILE_REF_THRESHOLD) {
        const file = join(tmpdir(), `agy-task-${randomUUID()}.txt`);
        await writeFile(file, prompt);
        tempFiles.push(file);
        prompt = `请先读取任务描述文件并完整阅读: ${file}\n文件中的内容是要执行的任务;读取后按其中要求执行,不要修改该文件。`;
    }
    // 等删除真正完成:调用方在流结束后 await 本函数,fire-and-forget 会留下
    // 竞态(实测),且图片/任务临时文件会堆积在 temp 目录。
    const cleanup = async () => {
        await Promise.allSettled(tempFiles.map(p => unlink(p).catch(() => { })));
    };
    return { prompt, cleanup };
}
