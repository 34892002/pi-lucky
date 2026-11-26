import { expect, test } from "bun:test";
import type { TranscriptMessage } from "../../contracts/desktop-state";
import { TOOL_IMAGE_ROUTE } from "../../contracts/tool-output-images";
import { HostTransport } from "../../src/host/transport";
import { toolOutputImages } from "../../src/features/conversation/tool-output-images";
import { transcriptForWindow, transcriptImageResponse } from "../application/app-store-utils";
import { PushBus } from "./push-bus";
import { RpcRegistry } from "./rpc-registry";
import { startSidecarServer } from "./sidecar-server";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg==";

test("loads a projected tool result as an authenticated PNG without exposing transcript bytes", async () => {
  const ref = { workspaceId: "workspace", sessionId: "session/encoded" };
  const message: TranscriptMessage = {
    kind: "tool", id: "read#1", callId: "call", toolName: "read", label: "Read PNG", status: "success", createdAt: "",
    output: { content: [
      { type: "text", text: "Read a PNG" },
      { type: "image", mimeType: "image/png", data: png },
      { type: "image", mimeType: "image/png", src: "https://example.com/image.png" },
    ] },
  };
  const transcript = [message];
  const projected = transcriptForWindow(ref, transcript);
  expect(JSON.stringify(projected)).not.toContain(png);
  expect(JSON.stringify(projected)).not.toContain("example.com");
  const images = toolOutputImages(projected[0]?.kind === "tool" ? projected[0].output : undefined);
  expect(images).toHaveLength(1);
  const src = images[0]!.src;

  const token = "test-token";
  const server = startSidecarServer({
    rpc: new RpcRegistry(), bus: new PushBus(), token, version: "test",
    toolImageResponse: (url) => transcriptImageResponse(url, () => transcript),
  });
  try {
    const transport = new HostTransport({ origin: server.origin, token });
    const signal = new AbortController().signal;
    const blob = await transport.loadToolImage(src, signal);
    expect(blob.type).toBe("image/png");
    expect(Buffer.from(await blob.arrayBuffer()).toString("base64")).toBe(png);
    await expect(transport.loadToolImage(src.replace(/1$/, "9"), signal)).rejects.toThrow("404");
    await expect(transport.loadToolImage("https://example.com/image.png", signal)).rejects.toThrow("Invalid");
    const route = `${server.origin}${TOOL_IMAGE_ROUTE}/workspace/session%2Fencoded/read%231/1`;
    expect((await fetch(route)).status).toBe(401);
    expect((await fetch(`${route}?token=${token}`)).status).toBe(401);
  } finally {
    server.stop();
  }
});
