import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const themeSpecSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(120),
  tokens: z.object({
    app: color,
    panel: color,
    ink: color,
    secondary: color,
    accent: color,
    accentInk: color,
  }).strict(),
}).strict().superRefine((theme, context) => {
  for (const [foreground, background] of [["ink", "app"], ["ink", "panel"], ["secondary", "app"], ["secondary", "panel"], ["accentInk", "accent"]] as const) {
    if (contrastRatio(theme.tokens[foreground], theme.tokens[background]) < 4.5) {
      context.addIssue({ code: "custom", path: ["tokens", foreground], message: `${foreground}/${background} contrast must be at least 4.5:1` });
    }
  }
});
export type ThemeSpec = z.infer<typeof themeSpecSchema>;

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

export function contrastRatio(first: string, second: string): number {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
