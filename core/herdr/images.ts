import { messageImageTargetAt, openMessageFile } from "../../server/message-file.ts";

/** Only an image embedded at this exact position in the authoritative message may be opened, within its project. */
export async function readHerdrImage(text: string, offset: number, project: string): Promise<{ dataUrl: string }> {
  const target = messageImageTargetAt(text, offset);
  if (!target) throw new Error("这条消息没有对应的图片引用");
  const file = await openMessageFile(target, [project]);
  try {
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime)) throw new Error("此引用不是支持的图片格式");
    return { dataUrl: `data:${file.mime};base64,${(await file.handle.readFile()).toString("base64")}` };
  } finally { await file.handle.close(); }
}
