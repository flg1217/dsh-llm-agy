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
/** 把 harness 消息序列化为 AGY 单轮 prompt;图片落盘为临时路径。 */
export async function buildPrompt(ctx, options) {
    const parts = [];
    if (options.system !== undefined && options.system.length > 0) {
        parts.push(`System instructions:\n${options.system}`);
    }
    const imagePaths = [];
    const taskFiles = [];
    const attachments = ctx.get('attachments');
    for (const message of options.messages) {
        const text = message.content
            .filter((block) => block.type === 'text')
            .map(block => block.text)
            .join('');
        const images = message.content.filter(block => block.type === 'image');
        if (images.length > 0 && attachments !== undefined) {
            for (const block of images) {
                if (block.type !== 'image')
                    continue;
                try {
                    const stored = await attachments.readImage(block.attachment);
                    const ext = IMAGE_EXT[stored.ref.mediaType] ?? 'img';
                    const file = join(tmpdir(), `agy-${randomUUID()}.${ext}`);
                    await writeFile(file, stored.data);
                    imagePaths.push(file);
                }
                catch {
                    // 附件不可读则跳过该图。
                }
            }
        }
        const label = message.role === 'assistant' ? 'Assistant' : 'User';
        const note = imagePaths.length > 0
            ? `\n[附带图片,请读取以下本地路径查看:${imagePaths.join(', ')}]`
            : '';
        parts.push(`${label}: ${text}${note}`);
        imagePaths.length = 0;
    }
    let prompt = parts.join('\n\n');
    // 超长 prompt 写入临时文件,命令行只给短引用(AGY 会自己读取文件)。
    if (prompt.length > FILE_REF_THRESHOLD) {
        const file = join(tmpdir(), `agy-task-${randomUUID()}.txt`);
        await writeFile(file, prompt);
        taskFiles.push(file);
        prompt = `请先读取任务描述文件并完整阅读: ${file}\n文件中的内容是要执行的任务;读取后按其中要求执行,不要修改该文件。`;
    }
    const cleanup = async () => {
        for (const p of imagePaths)
            void unlink(p).catch(() => { });
        for (const p of taskFiles)
            void unlink(p).catch(() => { });
    };
    return { prompt, cleanup };
}
