/**
 * Sidecar-side composer attachments: pi-gui read these from native dialogs and the
 * OS clipboard, both of which now live in the renderer.
 *
 * The renderer sends the *paths* it got from `Neutralino.os.showOpenDialog`; the
 * sidecar reads and validates them, because only it has filesystem access for the
 * agent and must apply the same byte/pixel limits as upstream.
 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  SUPPORTED_COMPOSER_IMAGE_TYPES,
  assertComposerImageBytes,
  assertComposerImageFileSizes,
  assertComposerImagePixels,
} from "../../contracts/composer-attachments";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
} from "../../contracts/desktop-state";
import { readImageSize } from "../platform/image-size";

const SUPPORTED_MIME_TYPES = new Set<string>(
  SUPPORTED_COMPOSER_IMAGE_TYPES.map((type) => type.mimeType),
);

export function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const supported = SUPPORTED_COMPOSER_IMAGE_TYPES.find((type) => type.extension === extension);
  return supported?.mimeType ?? "application/octet-stream";
}

async function readComposerAttachment(filePath: string): Promise<ComposerAttachment> {
  const mimeType = mimeTypeForPath(filePath);
  const name = path.basename(filePath);
  if (!mimeType.startsWith("image/")) {
    const stats = await stat(filePath);
    return {
      id: randomUUID(),
      kind: "file",
      name,
      mimeType,
      fsPath: filePath,
      sizeBytes: stats.size,
    };
  }

  const bytes = await readFile(filePath);
  assertComposerImageBytes(bytes.length);
  // Dimensions come from the file header: no image decoder is needed to enforce
  // the pixel limit, which is the only reason the renderer-side decode existed.
  const size = readImageSize(bytes);
  if (size) {
    assertComposerImagePixels(size.width, size.height);
  }
  return {
    id: randomUUID(),
    kind: "image",
    name,
    mimeType,
    data: bytes.toString("base64"),
  };
}

export async function readComposerAttachmentsFromPaths(
  filePaths: readonly string[],
  existing: readonly ComposerAttachment[] = [],
): Promise<ComposerAttachment[]> {
  const planned = filePaths.map((filePath) => ({
    filePath,
    mimeType: mimeTypeForPath(filePath),
  }));
  const imageSizes = await Promise.all(
    planned
      .filter((entry) => entry.mimeType.startsWith("image/"))
      .map(async (entry) => (await stat(entry.filePath)).size),
  );
  assertComposerImageFileSizes(imageSizes, existing);
  return Promise.all(planned.map((entry) => readComposerAttachment(entry.filePath)));
}

/**
 * Drop attachments that arrived malformed. The renderer is the only sender, so this
 * is about corruption, not trust — but a bad payload must not reach the store.
 */
export function validateComposerAttachmentPayload(
  attachment: ComposerAttachment,
): ComposerAttachment[] {
  if (attachment.kind === "image") {
    if (
      typeof attachment.data !== "string" ||
      typeof attachment.mimeType !== "string" ||
      !SUPPORTED_MIME_TYPES.has(attachment.mimeType)
    ) {
      return [];
    }
    return [{ ...attachment, kind: "image" }];
  }

  if (
    attachment.kind !== "file" ||
    typeof attachment.fsPath !== "string" ||
    typeof attachment.mimeType !== "string" ||
    typeof attachment.name !== "string"
  ) {
    return [];
  }

  const normalized: ComposerFileAttachment = {
    ...attachment,
    kind: "file",
  };
  return [normalized];
}
