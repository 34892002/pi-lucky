import {
  assertComposerImagePixels,
  composerImagePixelsLimitError,
  quarantineComposerAttachments,
} from "../../contracts/composer-attachments";
import type { ComposerAttachment } from "../../contracts/desktop-state";
import { readImageSizeFromBase64, type ImageSize } from "../platform/image-size";

function imageSize(attachment: ComposerAttachment): ImageSize | undefined {
  if (attachment.kind !== "image") {
    return undefined;
  }
  return readImageSizeFromBase64(attachment.data);
}

export function assertComposerAttachmentPixels(attachments: readonly ComposerAttachment[]): void {
  for (const attachment of attachments) {
    const size = imageSize(attachment);
    if (!size) {
      continue;
    }
    assertComposerImagePixels(size.width, size.height);
  }
}

export function quarantinePersistedComposerAttachments(
  attachments: readonly ComposerAttachment[],
): {
  readonly kept: ComposerAttachment[];
  readonly skipped: number;
} {
  const { kept: byteKept, skipped: byteSkipped } = quarantineComposerAttachments(attachments);
  const kept: ComposerAttachment[] = [];
  let skipped = byteSkipped;
  for (const attachment of byteKept) {
    const size = imageSize(attachment);
    if (size && composerImagePixelsLimitError(size.width, size.height)) {
      skipped += 1;
      continue;
    }
    kept.push(attachment);
  }
  return { kept, skipped };
}
