// Security: model text never turns an arbitrary local path into a browser request; transcript paths resolve through
// attachmentImageUrl.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  FolderOpen,
  ImageOff,
  LoaderCircle,
  Maximize2,
  RotateCcw,
  X,
} from "lucide-react";

import {
  attachmentBasename,
  attachmentImageUrl,
  type TranscriptFileAttachment,
  type TranscriptImageAttachment,
} from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { FilePreviewButton } from "./FilePreviewButton";
import { chipNameAction, SaveIconButton, useHtmlPreview } from "./HtmlFilePreview";
import { ImageLoading } from "./ImageLoading";

/**
 * Where the picture starts when it grows out of its thumbnail: the offset from the middle of the screen to the middle
 * of that box, and the scale that box is of the finished picture. Motion animates from this to `{x:0, y:0, scale:1}`,
 * which is the whole "it flew out of where I clicked" effect.
 */
function flipFrom(from: DOMRect): { x: number; y: number; scale: number; opacity: number } {
  const centreX = from.left + from.width / 2;
  const centreY = from.top + from.height / 2;
  const scale = Math.max(0.05, Math.min(from.width / Math.max(1, window.innerWidth * 0.6), from.height / Math.max(1, window.innerHeight * 0.6)));
  return {
    x: centreX - window.innerWidth / 2,
    y: centreY - window.innerHeight / 2,
    scale,
    opacity: 0.4,
  };
}

export interface PreviewImage {
  src: string;
  name: string;
  downloadUrl?: string;
  downloadName?: string;
  openUrl?: string;
}

export interface MessageAttachmentContext { threadId: string; messageId: string }

export function previewImage(path: string, name = attachmentBasename(path)): PreviewImage | null {
  const src = attachmentImageUrl(path);
  if (!src) return null;
  return {
    src,
    name,
    downloadUrl: src,
    downloadName: canonicalDownloadFilename({ fallback: name, source: path }),
  };
}

export function wrappedImageIndex(index: number, step: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (index + step + count) % count;
}

export type PreviewKeyAction = "close" | "previous" | "next" | null;

export function previewKeyAction(key: string, count: number): PreviewKeyAction {
  if (key === "Escape") return "close";
  if (count > 1 && key === "ArrowLeft") return "previous";
  if (count > 1 && key === "ArrowRight") return "next";
  return null;
}

export function imageGalleryLayout(count: number): string {
  // One picture sizes itself to its own aspect and stops at a readable width; a set of them shares a fixed grid so the
  // tiles line up. A single tile in a fixed-width grid leaves the grey canvas showing beside a square picture.
  if (count <= 1) return "w-fit max-w-[min(32rem,70vw)] grid-cols-1";
  if (count === 2) return "w-[min(36rem,70vw)] grid-cols-2";
  return "w-[min(38rem,70vw)] grid-cols-2 sm:grid-cols-3";
}

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
]);

export function safeDownloadFilename(value: string | null | undefined): string {
  const basename = (value ?? "").split(/[\\/]/).at(-1) ?? "";
  const cleaned = basename
    .normalize("NFC")
    // oxlint-disable-next-line no-control-regex -- strips control and bidi characters from a filename
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  const bounded = Array.from(cleaned)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character.length > 1 || code < 0xd800 || code > 0xdfff;
    })
    .slice(0, 180)
    .join("");
  if (!bounded) return "download";
  const stem = bounded.split(".", 1)[0]!.toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) ? `_${bounded}` : bounded;
}

/** Prefers RFC 5987's UTF-8 filename* form. */
export function contentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]*)/i.exec(header)?.[1]?.trim();
  if (encoded) {
    const unquoted = encoded.replace(/^"|"$/g, "");
    try {
      return safeDownloadFilename(decodeURIComponent(unquoted));
    } catch {
    }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header)?.[1];
  if (quoted !== undefined) return safeDownloadFilename(quoted.replace(/\\(.)/g, "$1"));
  const plain = /(?:^|;)\s*filename\s*=\s*([^;]*)/i.exec(header)?.[1]?.trim();
  return plain ? safeDownloadFilename(plain) : null;
}

function sourceImageExtension(source: string | undefined): string | null {
  if (!source) return null;
  let pathname = source;
  try {
    pathname = decodeURIComponent(new URL(source, "https://eacbot.invalid").pathname);
  } catch {
    pathname = source.split(/[?#]/, 1)[0] ?? source;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  return extension && IMAGE_EXTENSIONS.has(extension) ? extension : null;
}

function replaceExtension(name: string, extension: string): string {
  const suffix = `.${extension}`;
  const stem = name.replace(/\.[^.]*$/, "") || "image";
  const available = Math.max(1, 180 - Array.from(suffix).length);
  return `${Array.from(stem).slice(0, available).join("")}${suffix}`;
}

export function canonicalDownloadFilename({
  contentDisposition,
  fallback,
  source,
  mime,
}: {
  contentDisposition?: string | null;
  fallback?: string;
  source?: string;
  mime?: string | null;
}): string {
  const selected = contentDispositionFilename(contentDisposition ?? null)
    ?? safeDownloadFilename(fallback);
  const mediaType = mime?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const imageExtension = IMAGE_EXTENSION_BY_MIME[mediaType] ?? sourceImageExtension(source);
  return imageExtension ? replaceExtension(selected, imageExtension) : selected;
}

export function isExternalImageSource(src: string): boolean {
  const value = src.trim();
  // The URL parser drops embedded ASCII tab/LF/CR and treats backslashes as slashes for special schemes.
  const networkSpelling = value.replace(/[\t\n\r]/g, "").replace(/\\/g, "/");
  // Chromium canonicalizes special-scheme variants (`https:host/x`, `https:/host/x`, backslashes) into network
  // requests.
  return networkSpelling.startsWith("//") || /^https?:/i.test(networkSpelling);
}

/**
 * Security: the host path never enters the browser URL; the server proves this message rendered an image at this source
 * offset.
 */
export function messageImagePreviewUrl(
  message: MessageAttachmentContext,
  sourceOffset: number,
): string {
  return `/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file?preview=1&ref=${sourceOffset}`;
}

export async function messageImageOutsideWorkspace(src: string): Promise<boolean> {
  try {
    const response = await fetch(src, { cache: "no-store" });
    if (response.ok) {
      await response.body?.cancel();
      return false;
    }
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    return body?.code === "outside_workspace";
  } catch {
    return false;
  }
}

function revokeObjectUrlLater(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Security: never request a transcript path directly, even when it looks like a URL. */
export async function requestMessageFile(
  filePath: string,
  message: MessageAttachmentContext,
  signal: AbortSignal,
  folder?: { entry?: string; list?: boolean },
): Promise<Response> {
  const response = await fetch(`/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: filePath,
      ...(folder?.entry !== undefined ? { entry: folder.entry } : folder?.list ? { listFolder: true } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    throw Object.assign(new Error(body?.error ?? t("attach.downloadFailed")), { code: body?.code });
  }
  return response;
}

export interface MessageFolderListing {
  name: string;
  entries: { name: string; bytes: number; mime: string }[];
  truncated: boolean;
}

export function useLocalFileSave(filePath: string, name?: string, message?: MessageAttachmentContext, entry?: string) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [folder, setFolder] = useState<MessageFolderListing | null>(null);
  const [reason, setReason] = useState("");
  const [savedTo, setSavedTo] = useState("");
  const [outsideWorkspace, setOutsideWorkspace] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    saving.current = false;
    setReason("");
    setSavedTo("");
    setOutsideWorkspace(false);
    setFolder(null);
    setState("idle");
  }, [filePath, entry, message?.messageId, message?.threadId]);

  const save = useCallback(async () => {
    if (saving.current) return;
    if (!message) {
      setReason(t("attach.unavailableOld"));
      setState("failed");
      return;
    }
    saving.current = true;
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setReason("");
    setOutsideWorkspace(false);
    setState("saving");
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await requestMessageFile(filePath, message, controller.signal, entry === undefined ? { list: true } : { entry });
      if (response.headers.get("x-eacbot-folder") === "1") {
        const listing = await response.json() as MessageFolderListing;
        if (!mounted.current || controller.signal.aborted) return;
        setFolder(listing);
        setState("idle");
        return;
      }
      const blob = await response.blob();
      if (!mounted.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const saved = canonicalDownloadFilename({
        contentDisposition: response.headers.get("content-disposition"),
        fallback: name || entry || attachmentBasename(filePath),
        source: filePath,
        mime: blob.type || response.headers.get("content-type"),
      });
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = saved;
        link.style.display = "none";
        document.body.append(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
      } finally {
        // Chromium may not consume a blob URL until after the click task ends.
        revokeObjectUrlLater(url);
      }
      if (!mounted.current || controller.signal.aborted) return;
      setSavedTo(saved);
      setState("saved");
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        if (mounted.current) setState("idle");
      }, 4000);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setReason(error instanceof Error ? error.message : t("attach.saveFailed"));
      setOutsideWorkspace((error as { code?: unknown } | null)?.code === "outside_workspace");
      setState("failed");
    } finally {
      if (request.current === controller) {
        request.current = null;
        saving.current = false;
      }
    }
  }, [filePath, entry, message?.messageId, message?.threadId, name]);

  return { state, reason, savedTo, outsideWorkspace, folder, save };
}

export function saveFailureText(save: { reason: string; outsideWorkspace: boolean }): string {
  return save.outsideWorkspace ? t("attach.outsideWorkspace") : save.reason;
}

function folderFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

function MessageFolderFile({ folderPath, name, bytes, message }: {
  folderPath: string;
  name: string;
  bytes: number;
  message: MessageAttachmentContext;
}) {
  const save = useLocalFileSave(folderPath, name, message, name);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      <button
        type="button"
        onClick={() => void save.save()}
        disabled={save.state === "saving"}
        aria-label={t("attach.saveAria", { name })}
        className="inline-flex min-h-8 min-w-0 items-center gap-1 break-all text-start text-accent underline decoration-accent/40 hover:decoration-accent disabled:cursor-wait"
      >
        {save.state === "saving" ? (
          <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden="true" />
        ) : save.state === "saved" ? (
          <Check size={12} className="shrink-0 text-success" aria-hidden="true" />
        ) : (
          <FileText size={12} className="shrink-0" aria-hidden="true" />
        )}
        {name}
      </button>
      <span className="text-ink-secondary">{folderFileSize(bytes)}</span>
      {save.state === "failed" && <span role="alert" className="text-danger">{save.reason}</span>}
    </li>
  );
}

export function MessageFolderFiles({ folderPath, listing, message }: {
  folderPath: string;
  listing: MessageFolderListing;
  message: MessageAttachmentContext;
}) {
  return (
    <span dir="ltr" className="block w-full text-[12px] [unicode-bidi:isolate]">
      {listing.entries.length === 0 ? (
        <span className="text-ink-secondary">{t("attach.folderEmpty")}</span>
      ) : (
        <ul aria-label={t("attach.folderFilesAria", { name: listing.name })} className="flex flex-col gap-0.5 ps-1">
          {listing.entries.map((entry) => (
            <MessageFolderFile key={entry.name} folderPath={folderPath} name={entry.name} bytes={entry.bytes} message={message} />
          ))}
        </ul>
      )}
      {listing.truncated && <span className="text-ink-secondary">{t("attach.folderTruncated")}</span>}
    </span>
  );
}

const REVEALABLE_PATH = /^(?:\/(?!\/)|[a-zA-Z]:[\\/])/;
function revealBridge(): NonNullable<Window["ogb"]>["revealInFolder"] {
  const ogb = typeof window === "undefined" ? undefined : window.ogb;
  return ogb?.remoteClient?.active ? undefined : ogb?.revealInFolder;
}

export function OutsideWorkspaceFile({ filePath }: { filePath: string }) {
  const [problem, setProblem] = useState("");
  const reveal = revealBridge();
  if (!reveal || !REVEALABLE_PATH.test(filePath)) {
    return (
      <code title={t("attach.outsideWorkspacePath")} className="select-all break-all text-ink">
        {filePath}
      </code>
    );
  }
  const show = async () => {
    setProblem("");
    try {
      const result = await reveal(filePath);
      if (result === "missing") setProblem(t("attach.revealMissing"));
      else if (result !== "shown") setProblem(t("attach.revealFailed"));
    } catch {
      setProblem(t("attach.revealFailed"));
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void show()}
        title={filePath}
        className="inline-flex items-center gap-1 text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        <FolderOpen size={12} className="shrink-0" aria-hidden="true" />
        {t("attach.showInFolder")}
      </button>
      {problem && <span role="alert" className="text-danger">{problem}</span>}
    </>
  );
}

export function AttachmentPreviewDialog({
  image,
  images,
  initialIndex = 0,
  onClose,
  from,
}: {
  image: PreviewImage;
  images?: PreviewImage[];
  initialIndex?: number;
  onClose: () => void;
  /** The thumbnail's box: the picture grows out of it and shrinks back into it. Absent, it fades in place. */
  from?: DOMRect;
}) {
  const items = images?.length ? images : [image];
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), items.length - 1));
  const current = items[index] ?? image;
  const dialogRef = useRef<HTMLDivElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [loadedSources, setLoadedSources] = useState<Set<string>>(() => new Set());
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Closing plays the exit and only then tells the caller: the caller unmounts on its own flag, so without this the
  // dialog would vanish mid-gesture instead of shrinking away.
  const [leaving, setLeaving] = useState(false);

  const requestClose = useCallback(() => {
    setLeaving(true);
  }, []);

  // The picture's own flight, as a Web Animation: it starts at the thumbnail's box and scale, lands in the middle at
  // full size, and runs backwards to go home. The easing overshoots slightly, so the arrival has weight without a
  // library. Reduced motion lands it at once.
  useEffect(() => {
    const dialog = dialogRef.current;
    const veil = veilRef.current;
    if (!dialog || !veil) return;
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
    const start = from ? flipFrom(from) : { x: 0, y: 0, scale: 0.94, opacity: 0 };
    const home = { x: 0, y: 0, scale: 1, opacity: 1 };

    const flight = dialog.animate(
      [
        { transform: `translate3d(${start.x}px, ${start.y}px, 0) scale(${start.scale})`, opacity: String(start.opacity) },
        { transform: `translate3d(${home.x}px, ${home.y}px, 0) scale(${home.scale})`, opacity: String(home.opacity) },
      ],
      { duration: reduced ? 0 : (leaving ? 220 : 380), easing, fill: "both", direction: leaving ? "reverse" : "normal" },
    );
    const veilFade = veil.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: reduced ? 0 : (leaving ? 200 : 260), easing, fill: "both", direction: leaving ? "reverse" : "normal" },
    );

    if (leaving) {
      flight.onfinish = () => closeRef.current();
      // If the animation is cancelled (a background tab, a second close), the dialog must still go.
      const timer = window.setTimeout(() => closeRef.current(), 400);
      return () => {
        window.clearTimeout(timer);
        flight.cancel();
        veilFade.cancel();
      };
    }
    return () => {
      flight.cancel();
      veilFade.cancel();
    };
  }, [leaving, from]);

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const navigate = useCallback((step: -1 | 1) => {
    setIndex((value) => wrappedImageIndex(value, step, items.length));
    setFailedSource(null);
  }, [items.length]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const action = previewKeyAction(event.key, items.length);
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        if (action === "close") requestClose();
        else navigate(action === "previous" ? -1 : 1);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [items.length, navigate, requestClose]);

  const loaded = loadedSources.has(current.src);
  const failed = failedSource === current.src;
  const retry = () => {
    setFailedSource(null);
    setLoadedSources((sources) => {
      const next = new Set(sources);
      next.delete(current.src);
      return next;
    });
    setAttempt((value) => value + 1);
  };

  return createPortal(
    <div
      ref={veilRef}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/82 p-3 backdrop-blur-[16px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      {/* The picture itself is the only surface: no frame, no header bar. It grows out of the thumbnail it was clicked
          from, settles in the middle, and shrinks back into that same box on close. The controls float over it. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("attach.previewAria", { name: current.name })}
        tabIndex={-1}
        className="relative flex max-h-full max-w-full items-center justify-center outline-none"
      >
        <div className="relative max-h-full max-w-full">
          <img
            key={`${current.src}:${attempt}`}
            src={current.src}
            alt={current.name}
            draggable={false}
            onLoad={() => setLoadedSources((sources) => new Set(sources).add(current.src))}
            onError={() => setFailedSource(current.src)}
            className={cn(
              "block max-h-[calc(100vh-3rem)] max-w-[calc(100vw-3rem)] rounded-xl object-contain shadow-2xl transition-opacity duration-200",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
          {!loaded && !failed && (
            <div className="absolute inset-0 flex min-h-32 min-w-32 items-center justify-center rounded-xl bg-raised/70">
              <LoaderCircle size={20} className="animate-spin text-ink-tertiary" />
            </div>
          )}

          {failed && (
            <div className="flex min-h-32 min-w-32 flex-col items-center justify-center gap-2 rounded-xl bg-raised/70 p-4 text-center">
              <ImageOff size={22} className="text-ink-tertiary" />
              <span className="text-[12px] text-ink-secondary">{t("attach.imageUnavailable")}</span>
              <button
                type="button"
                onClick={retry}
                className="flex items-center gap-1 rounded-md border border-hairline/50 bg-panel px-2 py-1 text-[11px] text-ink hover:bg-raised"
              >
                <RotateCcw size={11} /> {t("chat.retry")}
              </button>
            </div>
          )}

          {/* The controls sit on the picture, not in a bar: a dark pill each, so they stay readable over any image. */}
          <div className="absolute right-2 top-2 flex items-center gap-1.5">
            {current.downloadUrl && (
              <a
                href={current.downloadUrl}
                download={current.downloadName ?? canonicalDownloadFilename({ fallback: current.name, source: current.src })}
                aria-label={t("attach.download")}
                className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white/85 backdrop-blur-md transition-colors hover:bg-black/80 hover:text-white"
              >
                <Download size={16} />
              </a>
            )}
            <button
              type="button"
              onClick={requestClose}
              aria-label={t("attach.close")}
              className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white/85 backdrop-blur-md transition-colors hover:bg-black/80 hover:text-white"
            >
              <X size={17} />
            </button>
          </div>

          {items.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => navigate(-1)}
                aria-label={t("attach.previous")}
                className="absolute left-2 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white/80 backdrop-blur-md transition-colors hover:bg-black/80 hover:text-white"
              >
                <ChevronLeft size={21} />
              </button>
              <button
                type="button"
                onClick={() => navigate(1)}
                aria-label={t("attach.next")}
                className="absolute right-2 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white/80 backdrop-blur-md transition-colors hover:bg-black/80 hover:text-white"
              >
                <ChevronRight size={21} />
              </button>
            </>
          )}

          {/* The name, quiet, under the picture rather than above it. */}
          <div className="pointer-events-none absolute -bottom-8 inset-x-0 flex justify-center">
            <span className="max-w-full truncate rounded-full bg-black/45 px-3 py-1 text-[11px] text-white/70 backdrop-blur-md">
              {current.name}
              {items.length > 1 && ` · ${t("attach.position", { index: index + 1, count: items.length })}`}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function AttachmentThumbnail({
  image,
  onPreview,
  className,
  eager = false,
  explainRefusal = false,
}: {
  image: PreviewImage;
  /** Receives the thumbnail's on-screen box, so the viewer can grow from it and shrink back into it. */
  onPreview: (from: DOMRect | undefined) => void;
  className?: string;
  eager?: boolean;
  explainRefusal?: boolean;
}) {
  // Callers key this by src: resetting in an effect races a cached image's onLoad, which can fire before the effect
  // runs.
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const [outsideWorkspace, setOutsideWorkspace] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);

  return (
    <span
      // A lone picture takes its own aspect at a sensible width; a set of them share equal cells so the tiles line up.
      // Sizing the box (not just the picture) is what stops the grey canvas showing beside a square picture.
      style={ratio ? { aspectRatio: String(ratio), width: `min(${ratio >= 1 ? "32rem" : `${32 * ratio}rem`}, 100%)` } : { aspectRatio: "4 / 3", width: "min(32rem, 100%)" }}
      className={cn("group/image relative block min-w-0 overflow-hidden rounded-xl border border-hairline/40 bg-inset", className)}
    >
      {state === "loading" && <ImageLoading name={image.name} className="absolute inset-0 bg-raised/65" />}
      {state === "failed" ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center text-ink-secondary" role="alert">
          <ImageOff size={22} />
          {outsideWorkspace ? (
            <span className="max-w-full text-[12px]">{t("attach.imageOutsideWorkspace")}</span>
          ) : (
            <span className="max-w-full truncate text-[12px]">{t("attach.imageUnavailable")}</span>
          )}
          {!outsideWorkspace && <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setState("loading");
              setAttempt((value) => value + 1);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              setState("loading");
              setAttempt((value) => value + 1);
            }}
            className="flex items-center gap-1 rounded-md border border-hairline/50 bg-panel px-2 py-1 text-[11px] text-ink hover:bg-raised"
            aria-label={t("attach.retryAria", { name: image.name })}
          >
            <RotateCcw size={11} /> {t("chat.retry")}
          </span>}
        </span>
      ) : (
        <span
          role="button"
          tabIndex={state === "ready" ? 0 : -1}
          aria-disabled={state !== "ready"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (state === "ready") onPreview(event.currentTarget.querySelector("img")?.getBoundingClientRect());
          }}
          onKeyDown={(event) => {
            if (state === "ready" && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              onPreview(event.currentTarget.querySelector("img")?.getBoundingClientRect());
            }
          }}
          className="absolute inset-0 block size-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 aria-disabled:cursor-default"
          aria-label={t("attach.previewImageAria", { name: image.name })}
          title={t("attach.previewAria", { name: image.name })}
        >
          <img
            key={`${image.src}:${attempt}`}
            src={image.src}
            alt={image.name}
            loading={eager ? "eager" : "lazy"}
            fetchPriority={eager ? "high" : undefined}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0) setRatio(Math.min(Math.max(naturalWidth / naturalHeight, 0.6), 2.4));
              setState("ready");
            }}
            onError={() => {
              setState("failed");
              if (explainRefusal) void messageImageOutsideWorkspace(image.src).then(setOutsideWorkspace);
            }}
            className={cn(
              "block size-full object-cover transition duration-200 group-hover/image:scale-[1.015]",
              state === "ready" ? "opacity-100" : "opacity-0",
            )}
          />
          <span className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100 group-focus-within/image:opacity-100">
            <Maximize2 size={13} />
          </span>
        </span>
      )}
    </span>
  );
}

export function AttachedImageGallery({
  paths,
  className,
  eager = false,
}: {
  paths: Array<string | TranscriptImageAttachment>;
  className?: string;
  eager?: boolean;
}) {
  const images = useMemo(() => paths.flatMap((reference) => {
    if (typeof reference !== "string" && !reference.private) return [];
    const path = typeof reference === "string" ? reference : reference.path;
    const name = typeof reference === "string" ? undefined : reference.name;
    const image = previewImage(path, name);
    return image ? [image] : [];
  }), [paths]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [selectedFrom, setSelectedFrom] = useState<DOMRect | undefined>(undefined);
  if (images.length === 0) return null;
  return (
    <>
      <div className={cn("mb-2 grid max-w-full gap-2", imageGalleryLayout(images.length), className)}>
        {images.map((image, index) => (
          <AttachmentThumbnail key={`${image.src}:${index}`} image={image} eager={eager} onPreview={(from) => {
            setSelectedFrom(from);
            setSelectedIndex(index);
          }} />
        ))}
      </div>
      {selectedIndex !== null && images[selectedIndex] && (
        <AttachmentPreviewDialog
          image={images[selectedIndex]}
          images={images}
          initialIndex={selectedIndex}
          from={selectedFrom}
          onClose={() => setSelectedIndex(null)}
        />
      )}
    </>
  );
}

export function MarkdownImagePreview({
  src,
  name,
  openUrl,
  message,
  filePath,
  sourceOffset,
}: {
  src: string;
  name: string;
  openUrl?: string;
  message?: MessageAttachmentContext;
  filePath?: string;
  sourceOffset?: number;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<DOMRect | undefined>(undefined);
  const containerRef = useRef<HTMLSpanElement>(null);
  const threadId = message?.threadId;
  const messageId = message?.messageId;
  const localSourceOffset = typeof sourceOffset === "number" && Number.isSafeInteger(sourceOffset) && sourceOffset >= 0
    ? sourceOffset
    : null;
  const localMessageImage = Boolean(
    filePath && threadId && messageId && localSourceOffset !== null,
  );
  const localImageKey = localMessageImage ? `${threadId}\u0000${messageId}\u0000${localSourceOffset}` : null;
  const [visibleLocalImageKey, setVisibleLocalImageKey] = useState<string | null>(null);
  const external = !filePath && isExternalImageSource(src);
  const [approvedExternalSource, setApprovedExternalSource] = useState<string | null>(null);

  useEffect(() => {
    if (!localImageKey) return;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisibleLocalImageKey(localImageKey);
      return;
    }
    setVisibleLocalImageKey(null);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisibleLocalImageKey(localImageKey);
      observer.disconnect();
    }, { rootMargin: "320px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [localImageKey]);

  const shouldLoadLocalImage = localMessageImage && (visibleLocalImageKey === localImageKey || open);
  const externalAllowed = !external || approvedExternalSource === src;
  const visibleSource = externalAllowed
    ? localMessageImage
      ? shouldLoadLocalImage && filePath && threadId && messageId && localSourceOffset !== null
        ? messageImagePreviewUrl({ threadId, messageId }, localSourceOffset)
        : null
      : src
    : null;
  const image: PreviewImage = {
    src: visibleSource ?? "",
    name,
    openUrl,
    downloadUrl: localMessageImage ? visibleSource ?? undefined : undefined,
    downloadName: localMessageImage
      ? canonicalDownloadFilename({ fallback: name, source: filePath })
      : undefined,
  };
  return (
    <>
      <span ref={containerRef} className="my-2 block w-[min(36rem,70vw)] max-w-full">
        {external && !externalAllowed ? (
          <span className="flex aspect-[4/3] max-h-96 flex-col items-center justify-center gap-2 rounded-xl border border-hairline/40 bg-inset px-4 text-center text-[12px] text-ink-secondary">
            <ImageOff size={20} />
            <span>{t("attach.externalHidden")}</span>
            <button type="button" className="rounded-md border border-hairline/50 bg-panel px-2.5 py-1 text-ink hover:bg-raised" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setApprovedExternalSource(src); }}>{t("attach.loadImage")}</button>
          </span>
        ) : filePath && (!threadId || !messageId || localSourceOffset === null) ? (
          <span className="flex aspect-[4/3] max-h-96 items-center justify-center gap-2 rounded-xl border border-hairline/40 bg-inset text-[12px] text-ink-secondary" role="alert">
            <ImageOff size={17} /> {t("attach.oldImage")}
          </span>
        ) : visibleSource ? (
          <AttachmentThumbnail key={image.src} image={image} className="max-h-96" eager explainRefusal={localMessageImage} onPreview={(from) => {
            setFrom(from);
            setOpen(true);
          }} />
        ) : (
          <ImageLoading name={name} className="aspect-[4/3] max-h-96 rounded-xl border border-hairline/40 bg-inset" />
        )}
        {openUrl && (
          <a href={openUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-[11px] text-accent hover:underline">
            {t("attach.openOriginal")}
          </a>
        )}
      </span>
      {open && visibleSource && <AttachmentPreviewDialog image={image} from={from} onClose={() => setOpen(false)} />}
    </>
  );
}

export function AttachedFileChip({ file, message, linked = false, compact = false, className }: {
  file: TranscriptFileAttachment;
  message?: MessageAttachmentContext;
  linked?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const save = useLocalFileSave(file.path, file.name, message);
  const preview = useHtmlPreview(file.path, file.name, message);
  const failed = save.state === "failed";
  const retryable = failed && !save.outsideWorkspace;
  if (compact) return <CompactFileChip file={file} message={message} linked={linked} save={save} preview={preview} className={className} />;
  if (!message || (!file.private && !linked)) {
    return (
      <div title={t("attach.legacyFile", { name: file.name })} className={cn("flex max-w-[280px] items-center gap-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset/70 px-2.5 py-2 text-[12px] text-ink-secondary", className)}>
        <FileText size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
        <span className="text-[11px]">{t("attach.unavailable")}</span>
      </div>
    );
  }
  return (
    <div
      title={save.state === "saved" && save.savedTo ? t("attach.savedTo", { path: save.savedTo }) : file.name}
      className={cn("max-w-[280px] overflow-hidden rounded-lg border border-hairline/40 bg-inset/70 text-[12px] text-ink-secondary", className)}
    >
      <div className="flex items-center pe-1">
        <button
          type="button"
          {...chipNameAction(preview, save, file.name, retryable)}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-wait disabled:hover:bg-transparent"
        >
          <FileText size={14} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
          {preview.html ? <Eye size={13} className="shrink-0" /> : save.state === "saving" ? (
            <LoaderCircle size={13} className="shrink-0 animate-spin" />
          ) : save.state === "saved" ? (
            <Check size={13} className="shrink-0 text-success" />
          ) : failed ? (
            retryable && <RotateCcw size={13} className="shrink-0 text-danger" />
          ) : (
            <Download size={13} className="shrink-0" />
          )}
        </button>
        {preview.html ? <SaveIconButton name={file.name} save={save} retryable={retryable} /> : <FilePreviewButton path={file.path} name={file.name} message={message} />}
        {preview.dialog}
      </div>
      {save.state !== "idle" && (
        <div
          role={failed ? "alert" : "status"}
          className={cn(
            "border-t border-hairline/30 px-2.5 py-1.5 text-[11px]",
            failed ? "text-danger" : save.state === "saved" ? "text-success" : "text-ink-secondary",
          )}
        >
          {save.state === "saving"
            ? t("attach.downloading")
            : save.state === "saved"
              ? t("attach.downloaded")
              : saveFailureText(save)}
          {failed && save.outsideWorkspace && (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5">
              <OutsideWorkspaceFile filePath={file.path} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FILE_CHIP = "inline-flex h-7 max-w-[16rem] items-center rounded-full bg-ink/[0.06] text-[13px] leading-none text-ink-secondary";

function CompactFileChip({ file, message, linked, save, preview, className }: {
  file: TranscriptFileAttachment;
  message?: MessageAttachmentContext;
  linked: boolean;
  save: ReturnType<typeof useLocalFileSave>;
  preview: ReturnType<typeof useHtmlPreview>;
  className?: string;
}) {
  const failed = save.state === "failed";
  const retryable = failed && !save.outsideWorkspace;
  const name = <span dir="auto" className="min-w-0 truncate text-ink [unicode-bidi:isolate]">{file.name}</span>;
  if (!message || (!file.private && !linked)) {
    return (
      <span title={t("attach.legacyFile", { name: file.name })} className={cn(FILE_CHIP, "gap-1.5 px-2.5", className)}>
        <FileText size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
        {name}
        <span className="shrink-0 text-[12px]">{t("attach.unavailable")}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      <span
        title={save.state === "saved" && save.savedTo ? t("attach.savedTo", { path: save.savedTo }) : file.name}
        className={cn(FILE_CHIP, "file-chip pe-0.5", className)}
      >
        <button
          type="button"
          {...chipNameAction(preview, save, file.name, retryable)}
          className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full ps-2.5 pe-2 transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait"
        >
          <FileText size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
          {name}
          {preview.html ? <Eye size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" /> : save.state === "saving" ? (
            <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden="true" />
          ) : save.state === "saved" ? (
            <Check size={13} className="shrink-0 text-success" aria-hidden="true" />
          ) : failed ? (
            retryable && <RotateCcw size={13} className="shrink-0 text-danger" aria-hidden="true" />
          ) : (
            <Download size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
          )}
        </button>
        {preview.html ? <SaveIconButton name={file.name} save={save} retryable={retryable} /> : <FilePreviewButton path={file.path} name={file.name} message={message} />}
        {preview.dialog}
      </span>
      {save.state !== "idle" && save.state !== "saved" && (
        <span role={failed ? "alert" : "status"} className={cn("px-2.5 text-[12px]", failed ? "text-danger" : "text-ink-secondary")}>
          {save.state === "saving" ? t("attach.downloading") : saveFailureText(save)}
          {failed && save.outsideWorkspace && (
            <span className="ms-1.5 inline-flex flex-wrap items-center gap-x-1.5"><OutsideWorkspaceFile filePath={file.path} /></span>
          )}
        </span>
      )}
      {save.state === "saved" && <span role="status" className="sr-only">{t("attach.downloaded")}</span>}
    </span>
  );
}

/** Security: transcript paths stay inert until the person asks the desktop shell to validate and save a copy. */
export function AttachedFileChips({ files, className, message }: { files: TranscriptFileAttachment[]; className?: string; message?: MessageAttachmentContext }) {
  if (files.length === 0) return null;
  return (
    <div className={cn("mb-2 flex max-w-full flex-wrap justify-end gap-1.5", className)}>
      {files.map((file, index) => (
        <AttachedFileChip key={`${file.path}:${index}`} file={file} message={message} />
      ))}
    </div>
  );
}
