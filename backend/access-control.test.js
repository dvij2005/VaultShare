const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findOwnedFile,
  findEnabledRecipient,
  isAuthorizedSharedFile
} = require("./access-control");

test("findOwnedFile requires both the owner and file id", () => {
  const file = { ownerId: "owner-1", fileId: "file-1" };

  assert.deepEqual(findOwnedFile([file], "owner-1", "file-1"), file);
  assert.equal(findOwnedFile([file], "owner-2", "file-1"), undefined);
  assert.equal(findOwnedFile([file], "owner-1", "file-2"), undefined);
});

test("findEnabledRecipient rejects disabled users and matches the verified sub", () => {
  const enabled = {
    Enabled: true,
    UserStatus: "CONFIRMED",
    Attributes: [
      { Name: "email", Value: "recipient@example.com" },
      { Name: "sub", Value: "recipient-sub" }
    ]
  };
  const disabled = { ...enabled, Enabled: false };

  assert.equal(
    findEnabledRecipient([enabled], "RECIPIENT@example.com").Attributes[1].Value,
    "recipient-sub"
  );
  assert.equal(findEnabledRecipient([disabled], "recipient@example.com"), undefined);
});

test("isAuthorizedSharedFile requires recipient, active status, and view permission", () => {
  const share = {
    recipientId: "recipient-sub",
    status: "active",
    permission: "view_download"
  };

  assert.equal(isAuthorizedSharedFile(share, "recipient-sub"), true);
  assert.equal(isAuthorizedSharedFile(share, "other-sub"), false);
  assert.equal(
    isAuthorizedSharedFile({ ...share, status: "revoked" }, "recipient-sub"),
    false
  );
  assert.equal(
    isAuthorizedSharedFile({ ...share, permission: "edit" }, "recipient-sub"),
    false
  );
});
