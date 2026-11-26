/**
 * Images a tool returned in its result content. pi stores each as an `{ type: "image", data,
 * mimeType }` block. Main keeps the data and gives the window a `pi-gui-image://` URL for each
 * image it can show. A tool row shows no other image source, so a tool result's image blocks can't
 * make it load a remote or local file.
 */

/** Logical image references carried by the transcript, not network URLs. */
export const TOOL_IMAGE_SCHEME = "pi-gui-image";
export const TOOL_IMAGE_ROUTE = "/tool-images";

export function toolImagePath(src: string): string | undefined {
  const prefix = `${TOOL_IMAGE_SCHEME}://image/`;
  if (!src.startsWith(prefix)) return undefined;
  const path = src.slice(prefix.length);
  const segments = path.split("/");
  if (segments.length !== 4 || !/^\d+$/.test(segments[3] ?? "")) return undefined;
  for (const id of segments.slice(0, 3)) {
    if (!/^(?:[\w.!~*'()-]|%[0-9A-Fa-f]{2})+$/.test(id) || /^(?:\.|%2e){1,2}$/i.test(id)) {
      return undefined;
    }
  }
  return `/${path}`;
}

const SHOWN_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Any image block in a tool result, shown or not. */
export function isToolImageBlock(value: unknown): value is { type: "image"; mimeType?: unknown } {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "image"
  );
}

/** An image block as pi stores it, with data of a type the window shows. */
export function isShownToolImageData(
  value: unknown,
): value is { type: "image"; data: string; mimeType: string } {
  if (!isToolImageBlock(value)) return false;
  const { data, mimeType } = value as Record<string, unknown>;
  return (
    typeof data === "string" && typeof mimeType === "string" && SHOWN_IMAGE_TYPES.has(mimeType)
  );
}

/** An image block as main sends it to the window, pointing at main's own image URL. */
export function isShownToolImageUrl(
  value: unknown,
): value is { type: "image"; src: string; mimeType: string } {
  if (!isToolImageBlock(value)) return false;
  const { src, mimeType } = value as Record<string, unknown>;
  return (
    typeof src === "string" &&
    toolImagePath(src) !== undefined &&
    typeof mimeType === "string" &&
    SHOWN_IMAGE_TYPES.has(mimeType)
  );
}
