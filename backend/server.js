const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const crypto = require("crypto");
const path = require("path");
const { pipeline } = require("stream");
const { promisify } = require("util");
const { CognitoJwtVerifier } = require("aws-jwt-verify");

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const { CognitoIdentityProviderClient, ListUsersCommand } = require("@aws-sdk/client-cognito-identity-provider");

const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand
} = require("@aws-sdk/lib-dynamodb");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  findOwnedFile,
  findEnabledRecipient,
  isAuthorizedSharedFile
} = require("./access-control");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const BUCKET = process.env.S3_BUCKET_NAME;
const TABLE = process.env.DYNAMODB_TABLE_NAME;
const SHARES_TABLE = process.env.SHARES_TABLE_NAME || "VaultShareShares";
const pipelineAsync = promisify(pipeline);

if (
  !process.env.AWS_REGION ||
  !BUCKET ||
  !TABLE ||
  !process.env.COGNITO_USER_POOL_ID ||
  !process.env.COGNITO_CLIENT_ID
) {
  throw new Error("Required configuration is missing from backend/.env");
}

const s3 = new S3Client({
  region: process.env.AWS_REGION
});

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: process.env.AWS_REGION
  })
);

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION
});

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "access",
  clientId: process.env.COGNITO_CLIENT_ID
});

// Authentication middleware
async function requireAuth(req, res, next) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer (.+)$/i);

  if (!match) {
    return res.status(401).json({
      success: false,
      message: "Authentication required. Please sign in."
    });
  }

  try {
    req.user = await verifier.verify(match[1]);
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token."
    });
  }
}

app.use(cors({ origin: ["http://localhost:5173", "https://18.61.69.28"] }));
app.use(express.json());

// Supported document, image, archive, and video formats
const allowedTypes = {
  ".pdf": ["application/pdf"],
  ".doc": ["application/msword"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ],
  ".txt": ["text/plain"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".zip": ["application/zip", "application/x-zip-compressed"],
  ".mp4": ["video/mp4"],
  ".webm": ["video/webm"],
  ".mov": ["video/quicktime"],
  ".avi": ["video/x-msvideo"],
  ".mkv": ["video/x-matroska"]
};

// Upload configuration: maximum 100 MB per file, 10 files per request
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 10
  },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const allowedMimes = allowedTypes[extension];

    if (!allowedMimes || !allowedMimes.includes(file.mimetype)) {
      return callback(
        new Error(
          "Unsupported file type. Upload PDF, DOC, DOCX, TXT, PNG, JPG, ZIP, MP4, WEBM, MOV, AVI or MKV files."
        )
      );
    }

    return callback(null, true);
  }
});

// Convert DynamoDB records to the frontend's expected format
function toPublicFile(item) {
  return {
    id: item.fileId,
    name: item.name,
    sizeBytes: item.sizeBytes,
    mimeType: item.mimeType,
    uploadedAt: item.uploadedAt,
    owner: item.ownerId
  };
}

// API health endpoints
app.get("/", (req, res) => {
  res.json({
    message: "Secure Digital File Exchange API",
    status: "running"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Backend is working correctly"
  });
});

// List only files belonging to the authenticated user
app.get("/api/files", requireAuth, async (req, res, next) => {
  try {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "ownerId = :owner",
        ExpressionAttributeValues: {
          ":owner": req.user.sub
        }
      })
    );

    return res.json({
      success: true,
      files: (result.Items || []).map(toPublicFile)
    });
  } catch (error) {
    return next(error);
  }
});

// Upload files to S3 and store metadata in DynamoDB
app.post("/api/files/upload", requireAuth, (req, res, next) => {
  upload.array("files", 10)(req, res, async (error) => {
    if (error) return next(error);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Select at least one file."
      });
    }

    const added = [];

    // Tracks uploaded S3 objects whose metadata write has not completed.
    const pendingS3Keys = [];

    try {
      for (const file of req.files) {
        const fileId = crypto.randomUUID();
        const extension = path.extname(file.originalname).toLowerCase();
        const s3Key = `${req.user.sub}/${fileId}${extension}`;

        // Upload the object to private S3 storage.
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: s3Key,
            Body: file.buffer,
            ContentLength: file.size,
            ContentType: file.mimetype
          })
        );

        // Track this object until its metadata write succeeds.
        pendingS3Keys.push(s3Key);

        const item = {
          ownerId: req.user.sub,
          fileId,
          name: file.originalname,
          s3Key,
          sizeBytes: file.size,
          mimeType: file.mimetype,
          uploadedAt: new Date().toISOString()
        };

        await dynamo.send(
          new PutCommand({
            TableName: TABLE,
            Item: item,
            ConditionExpression:
              "attribute_not_exists(ownerId) AND attribute_not_exists(fileId)"
          })
        );

        // Metadata write succeeded. Preserve this S3 object even if
        // a later file in this same request fails.
        pendingS3Keys.pop();

        added.push(toPublicFile(item));
      }

      return res.status(201).json({
        success: true,
        message: `${added.length} file(s) uploaded successfully.`,
        files: added
      });
    } catch (error) {
      console.error(
        "Upload/metadata error:",
        error.name,
        error.message
      );

      // Delete only objects whose metadata writes have not completed.
      const cleanupResults = await Promise.allSettled(
        pendingS3Keys.map((key) =>
          s3.send(
            new DeleteObjectCommand({
              Bucket: BUCKET,
              Key: key
            })
          )
        )
      );

      cleanupResults.forEach((result, index) => {
        if (result.status === "rejected") {
          console.error(
            "S3 cleanup failed for key:",
            pendingS3Keys[index],
            result.reason?.message || result.reason
          );
        }
      });

      return next(error);
    }
  });
});

// Share an owned file with an existing Cognito user by email.
app.post("/api/files/:id/share", requireAuth, async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Enter a valid registered email address." });
    }

    const ownedResult = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "ownerId = :owner AND fileId = :fileId",
      ExpressionAttributeValues: { ":owner": req.user.sub, ":fileId": req.params.id },
      Limit: 1
    }));
    const file = findOwnedFile(ownedResult.Items, req.user.sub, req.params.id);
    if (!file) return res.status(404).json({ success: false, message: "File not found in your account." });

    const usersResult = await cognito.send(new ListUsersCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID,
      Filter: `email = "${email.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
      Limit: 10
    }));
    const recipient = findEnabledRecipient(usersResult.Users, email);
    const recipientId = recipient?.Attributes?.find(attr => attr.Name === "sub")?.Value;
    if (!recipientId) return res.status(404).json({ success: false, message: "No registered VaultShare user was found for that email." });
    if (recipientId === req.user.sub) return res.status(400).json({ success: false, message: "You already own this file." });

    const existing = await dynamo.send(new QueryCommand({
      TableName: SHARES_TABLE,
      KeyConditionExpression: "recipientId = :recipient",
      FilterExpression: "ownerId = :owner AND fileId = :fileId AND #status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":recipient": recipientId, ":owner": req.user.sub, ":fileId": file.fileId, ":active": "active" }
    }));
    if ((existing.Items || []).length) return res.status(409).json({ success: false, message: "This file is already shared with that user." });

    const share = {
      recipientId,
      shareId: crypto.randomUUID(),
      ownerId: req.user.sub,
      fileId: file.fileId,
      fileName: file.name,
      recipientEmail: email,
      permission: "view_download",
      status: "active",
      createdAt: new Date().toISOString()
    };
    try {
      await dynamo.send(new PutCommand({
        TableName: SHARES_TABLE,
        Item: share,
        ConditionExpression: "attribute_not_exists(recipientId) AND attribute_not_exists(shareId)"
      }));
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") {
        return res.status(409).json({
          success: false,
          message: "This file is already shared with that user."
        });
      }
      throw error;
    }
    return res.status(201).json({ success: true, message: `Shared ${file.name} with ${email}.` });
  } catch (error) { return next(error); }
});

// List active files shared with the signed-in recipient.
app.get("/api/shared-with-me", requireAuth, async (req, res, next) => {
  try {
    const sharesResult = await dynamo.send(new QueryCommand({
      TableName: SHARES_TABLE,
      KeyConditionExpression: "recipientId = :recipient",
      ExpressionAttributeValues: { ":recipient": req.user.sub }
    }));
    const activeShares = (sharesResult.Items || []).filter(share => share.status === "active");
    const files = await Promise.all(activeShares.map(async share => {
      const result = await dynamo.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "ownerId = :owner AND fileId = :fileId",
        ExpressionAttributeValues: { ":owner": share.ownerId, ":fileId": share.fileId },
        Limit: 1
      }));
      const file = findOwnedFile(result.Items, share.ownerId, share.fileId);
      if (!file) return null;
      return {
        ...toPublicFile(file),
        shareId: share.shareId,
        sharedAt: share.createdAt,
        permission: share.permission,
        ownerId: share.ownerId
      };
    }));
    return res.json({ success: true, files: files.filter(Boolean) });
  } catch (error) { return next(error); }
});

// Return one shared file's metadata after checking the recipient's share record.
app.get("/api/shared-with-me/:shareId", requireAuth, async (req, res, next) => {
  try {
    const shareResult = await dynamo.send(new GetCommand({
      TableName: SHARES_TABLE,
      Key: { recipientId: req.user.sub, shareId: req.params.shareId }
    }));
    const share = shareResult.Item;
    if (!isAuthorizedSharedFile(share, req.user.sub)) {
      return res.status(404).json({ success: false, message: "Shared file not found or access has been revoked." });
    }

    const fileResult = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "ownerId = :owner AND fileId = :fileId",
      ExpressionAttributeValues: { ":owner": share.ownerId, ":fileId": share.fileId },
      Limit: 1
    }));
    const file = findOwnedFile(fileResult.Items, share.ownerId, share.fileId);
    if (!file) return res.status(404).json({ success: false, message: "Original file is no longer available." });

    return res.json({
      success: true,
      file: {
        ...toPublicFile(file),
        shareId: share.shareId,
        sharedAt: share.createdAt,
        permission: share.permission,
        ownerId: share.ownerId
      }
    });
  } catch (error) {
    return next(error);
  }
});

// Recipient downloads only if an active share exists for their Cognito subject.
app.get("/api/shared-with-me/:shareId/download", requireAuth, async (req, res, next) => {
  try {
    const shareResult = await dynamo.send(new GetCommand({
      TableName: SHARES_TABLE,
      Key: { recipientId: req.user.sub, shareId: req.params.shareId }
    }));
    const share = shareResult.Item;
    if (!isAuthorizedSharedFile(share, req.user.sub)) {
      return res.status(404).json({ success: false, message: "Shared file not found or access has been revoked." });
    }
    const fileResult = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "ownerId = :owner AND fileId = :fileId",
      ExpressionAttributeValues: { ":owner": share.ownerId, ":fileId": share.fileId },
      Limit: 1
    }));
    const file = findOwnedFile(fileResult.Items, share.ownerId, share.fileId);
    if (!file) return res.status(404).json({ success: false, message: "Original file is no longer available." });
    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: file.s3Key }));
    const safeName = encodeURIComponent(file.name).replace(/['()]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${safeName}`);
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    if (object.ContentLength !== undefined) res.setHeader("Content-Length", object.ContentLength);
    await pipelineAsync(object.Body, res);
  } catch (error) {
    if (res.headersSent) { res.destroy(error); return; }
    return next(error);
  }
});

// Download only files owned by the authenticated user
app.get(
  "/api/files/:id/download",
  requireAuth,
  async (req, res, next) => {
    try {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression:
            "ownerId = :owner AND fileId = :fileId",
          ExpressionAttributeValues: {
            ":owner": req.user.sub,
            ":fileId": req.params.id
          },
          Limit: 1
        })
      );

      const file = result.Items && result.Items[0];

      if (!file) {
        return res.status(404).json({
          success: false,
          message: "File not found."
        });
      }

      const object = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: file.s3Key
        })
      );

      const safeName = encodeURIComponent(file.name).replace(
        /['()]/g,
        (character) =>
          "%" + character.charCodeAt(0).toString(16).toUpperCase()
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${safeName}`
      );

      res.setHeader(
        "Content-Type",
        file.mimeType || "application/octet-stream"
      );

      if (object.ContentLength !== undefined) {
        res.setHeader("Content-Length", object.ContentLength);
      }

      await pipelineAsync(object.Body, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      return next(error);
    }
  }
);

// Centralized API error handling
app.use((err, req, res, next) => {
  console.error("API error:", err.name, err.message);

  if (res.headersSent) return next(err);

  const status = err instanceof multer.MulterError ? 400 : 500;

  return res.status(status).json({
    success: false,
    message:
      status === 400
        ? err.message
        : "The request failed. Check the backend terminal for details."
  });
});

// Start backend server
app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
  console.log(`S3 bucket: ${BUCKET}`);
  console.log(`DynamoDB table: ${TABLE}`);
});