import test from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeEditRequest,
  looksLikeReferentialFilesystemFollowUp,
  extractBareFileReference,
  inferFilesystemTarget,
} from "./filesystem-intent.mjs";

test("looksLikeEditRequest detects plain-language edit requests", () => {
  assert.equal(
    looksLikeEditRequest("change the contents of the page.tsx to be a dashboard"),
    true
  );
  assert.equal(looksLikeEditRequest("what is on my desktop"), false);
});

test("looksLikeReferentialFilesystemFollowUp detects pronoun follow-ups", () => {
  assert.equal(looksLikeReferentialFilesystemFollowUp("What's in it"), true);
  assert.equal(looksLikeReferentialFilesystemFollowUp("Open it"), true);
  assert.equal(looksLikeReferentialFilesystemFollowUp("Tell me a joke"), false);
});

test("extractBareFileReference finds common filenames", () => {
  assert.equal(
    extractBareFileReference("change the contents of page.tsx"),
    "page.tsx"
  );
  assert.equal(extractBareFileReference("show desktop"), "");
});

test("inferFilesystemTarget resolves Desktop and bare files", () => {
  const config = {
    homeDir: "/home/tester",
    desktopDir: "/home/tester/Desktop",
    workspaceRoot: "/home/tester",
  };
  assert.deepEqual(inferFilesystemTarget("go to my Desktop", config), {
    kind: "dir",
    path: "/home/tester/Desktop",
  });
  assert.deepEqual(
    inferFilesystemTarget("edit page.tsx", {
      ...config,
      fallbackDir: "/home/tester/Desktop/office/src/app",
    }),
    {
      kind: "file",
      path: "/home/tester/Desktop/office/src/app/page.tsx",
    }
  );
});
