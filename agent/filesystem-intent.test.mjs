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
  assert.equal(looksLikeEditRequest("recode that page to look like a bank dashboard"), true);
  assert.equal(looksLikeEditRequest("redesign the home page"), true);
  assert.equal(looksLikeEditRequest("rebuild the login component"), true);
  assert.equal(looksLikeEditRequest("transform this into a dark theme"), true);
  assert.equal(looksLikeEditRequest("revamp the dashboard layout"), true);
  assert.equal(looksLikeEditRequest("overhaul the styling"), true);
  assert.equal(looksLikeEditRequest("rework the navigation"), true);
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
