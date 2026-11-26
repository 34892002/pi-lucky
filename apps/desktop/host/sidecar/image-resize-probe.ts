import assert from "node:assert/strict";
import { resizeImage } from "@earendil-works/pi-coding-agent";

// White RGBA PNGs: one already within limits, one a pixel over the width limit.
const smallPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg==";
const widePng = "iVBORw0KGgoAAAANSUhEUgAAB9EAAAABCAYAAABpP15DAAAAZ0lEQVR4Ae3AA6AkWZbG8f937o3IzKdyS2Oubdu2bdu2bdu2bWmMnpZKr54yMyLu+Xa3anqmhztr1a/aNlddddVVV1111VVXXXXVVVddddVVV1111VVXXXXVVVddddVVV131/xsA/wgwogQBnm9JrwAAAABJRU5ErkJggg==";

export async function probeImageResize(): Promise<void> {
  const small = await resizeImage(Buffer.from(smallPng, "base64"), "image/png");
  assert.ok(small, "Pi could not decode the small PNG; check the packaged Photon WASM");
  assert.equal(small.wasResized, false);
  assert.equal(small.mimeType, "image/png");
  assert.equal(small.data, smallPng);

  const wide = await resizeImage(Buffer.from(widePng, "base64"), "image/png");
  assert.ok(wide, "Pi could not resize the oversized PNG");
  assert.equal(wide.wasResized, true);
  assert.equal(wide.originalWidth, 2001);
  assert.equal(wide.width, 2000);
  assert.equal(wide.height, 1);
  console.log("PASS: Pi preserved the small PNG and resized the oversized PNG");
}
