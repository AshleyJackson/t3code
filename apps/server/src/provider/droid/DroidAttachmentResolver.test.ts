import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";

import { resolveDroidImages } from "./DroidAttachmentResolver.ts";

it.effect("ignores file attachments because their paths are added to the prompt", () =>
  Effect.gen(function* () {
    const images = yield* resolveDroidImages(
      [
        {
          type: "file",
          id: "pasted-text-2",
          name: "pasted-text-2.txt",
          mimeType: "text/plain;charset=utf-8",
          sizeBytes: 354,
          source: { _tag: "pasted-text" },
        },
      ],
      {
        attachmentsDir: "unused",
        fileSystem: {} as never,
      },
    );

    NodeAssert.deepEqual(images, []);
  }),
);
