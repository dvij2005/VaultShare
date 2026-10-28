function findOwnedFile(items, ownerId, fileId) {
  return (items || []).find(
    (item) => item.ownerId === ownerId && item.fileId === fileId
  );
}

function findEnabledRecipient(users, email) {
  const normalizedEmail = email.toLowerCase();

  return (users || []).find((user) => {
    if (user.Enabled === false || user.UserStatus === "DISABLED") {
      return false;
    }

    const attributes = user.Attributes || [];
    const userEmail = attributes.find((attribute) => attribute.Name === "email");
    const sub = attributes.find((attribute) => attribute.Name === "sub");

    return (
      Boolean(sub?.Value) &&
      String(userEmail?.Value || "").toLowerCase() === normalizedEmail
    );
  });
}

function isAuthorizedSharedFile(share, recipientId) {
  return (
    share &&
    share.recipientId === recipientId &&
    share.status === "active" &&
    share.permission === "view_download"
  );
}

module.exports = {
  findOwnedFile,
  findEnabledRecipient,
  isAuthorizedSharedFile
};
