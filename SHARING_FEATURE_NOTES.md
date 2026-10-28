# VaultShare sharing feature update

This update adds registered-user sharing by email and a Shared with me view. Do not upload `.env` files or node_modules.

## Before deployment
1. Back up the current EC2 files and keep the currently running deployment available for rollback.
2. In backend, run `npm install` to install the already-declared `@aws-sdk/client-cognito-identity-provider` dependency.
3. Confirm the EC2 role `VaultShareEC2Access` has the `VaultShareFileSharingPolicy` inline policy.
4. Keep the existing DynamoDB table `VaultShareFiles`; the new table must be `VaultShareShares` with partition key `recipientId` (String) and sort key `shareId` (String).
5. Frontend production uses same-origin `/api` calls. Local Vite development uses `http://localhost:5000` by default.
6. Build the frontend (`npm run build`) before replacing `frontend/dist`.

## New backend routes
- `POST /api/files/:id/share` JSON body `{ "email": "registered-user@example.com" }`
- `GET /api/shared-with-me`
- `GET /api/shared-with-me/:shareId`
- `GET /api/shared-with-me/:shareId/download`

All routes require a valid Cognito access token. Sharing records grant `view_download` only.
The backend resolves recipients to enabled Cognito `sub` values, verifies
ownership using the existing file table key pair, and checks the recipient
share record again before every metadata response or download. Owner revoke
is intentionally not exposed because the existing sharing table has no
owner/file index; adding a table scan would be unsafe and inefficient.
