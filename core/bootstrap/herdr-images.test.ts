import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readHerdrImage } from "../herdr/images.ts";

it("reads only the embedded image at the requested message offset and confines it to the project", async () => {
  const root = await mkdtemp("/tmp/eac-herdr-image-");
  const outside = await mkdtemp("/tmp/eac-herdr-image-outside-");
  try {
    const image = join(root, "image with spaces.png");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    await writeFile(image, bytes);
    const text = `Here is the image.\n\n![sample](<${image}>)`;
    expect(await readHerdrImage(text, text.indexOf("!["), root)).toEqual({ dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
    await expect(readHerdrImage(text, 0, root)).rejects.toThrow("图片引用");
    await expect(readHerdrImage(`[ordinary link](<${image}>)`, 0, root)).rejects.toThrow("图片引用");
    const secret = join(outside, "outside.png"); await writeFile(secret, bytes);
    await symlink(secret, join(root, "escape.png"));
    await expect(readHerdrImage("![escape](escape.png)", 0, root)).rejects.toMatchObject({ status: 403 });
    await writeFile(join(root, "plain.txt"), "not an image");
    await expect(readHerdrImage("![text](plain.txt)", 0, root)).rejects.toThrow("图片格式");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
