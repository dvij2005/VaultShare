# Vaultshare

Secure file exchange application with a React frontend and an Express backend using Amazon Cognito, S3, and DynamoDB.

## Configuration

Copy the example environment files and fill them with your own AWS and Cognito configuration:

```powershell
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env
```

Real `.env` files, uploaded files, local metadata, dependencies, and build output are ignored by Git and must not be committed.

For local AWS development, use an AWS profile or IAM role where possible instead of long-lived access keys. If access keys are used, keep them only in the local environment and rotate them immediately if they are exposed.

## Run locally

Install dependencies in each application directory, then start the backend and frontend:

```powershell
cd backend
npm install
npm start
```

```powershell
cd frontend
npm install
npm run dev
```

## Sharing deployment checklist

The backend uses the existing `VaultShareShares` table with `recipientId` as
the partition key and `shareId` as the sort key. Do not change the existing
table keys or make the S3 bucket public.

The EC2 role used by the backend needs these minimum permissions in addition
to the existing owner-file permissions:

- `cognito-idp:ListUsers` on the configured Cognito user pool
- `dynamodb:PutItem` on `VaultShareShares`
- `dynamodb:Query` and `dynamodb:GetItem` on `VaultShareShares`
- `dynamodb:Query` on `VaultShareFiles`
- `s3:GetObject` on the existing private bucket

Review the existing `VaultShareFileSharingPolicy` before deployment and add
only missing actions; do not overwrite the inline policy automatically.

After local validation, deploy without changing AWS resources:

```powershell
cd backend
npm install
npm test
node --check server.js

cd ..\frontend
npm install
npm run build
```

Copy the backend source and frontend build using the existing deployment
process, restart `vaultshare.service`, and verify `/api/health`. No EC2,
S3, Cognito, Nginx, or systemd changes are required by this feature.
