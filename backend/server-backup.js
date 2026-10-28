
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

const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand
} = require("@aws-sdk/lib-dynamodb");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const BUCKET = process.env.S3_BUCKET_NAME;
const TABLE = process.env.DYNAMODB_TABLE_NAME;
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

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "access",
  clientId: process.env.COGNITO_CLIENT_ID
});

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
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token."
    });
  }
}

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());


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

  // Video formats
  ".mp4": ["video/mp4"],
  ".webm": ["video/webm"],
  ".mov": ["video/quicktime"],
  ".avi": ["video/x-msvideo"],
  ".mkv": ["video/x-matroska"]
};


const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
  fileSize: 100 * 1024 * 1024, // 100 MB per file
  files: 10
},
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const allowedMimes = allowedTypes[extension];

    if (!allowedMimes || !allowedMimes.includes(file.mimetype)) {
      return callback(
        new Error(
          "Unsupported file type. Upload PDF, DOC, DOCX, TXT, PNG, JPG or ZIP files."
        )
      );
    }

    callback(null, true);
  }
});

// Convert DynamoDB records to the frontend's expected format.
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

// List only files owned by the authenticated user.
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

    res.json({
      success: true,
      files: (result.Items || []).map(toPublicFile)
    });
  } catch (error) {
    next(error);
  }
});

// Upload files to S3 and save their metadata in DynamoDB.
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
    const uploadedKeys = [];

    try {
      for (const file of req.files) {
        const fileId = crypto.randomUUID();
        const extension = path.extname(file.originalname).toLowerCase();
        const s3Key = `${req.user.sub}/${fileId}${extension}`;

        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: s3Key,
            Body: file.buffer,
            ContentLength: file.size,
            ContentType: file.mimetype
          })
        );

        // Track the object immediately after the S3 upload succeeds.
        uploadedKeys.push(s3Key);

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

        added.push(toPublicFile(item));
      }

      res.status(201).json({
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

      // Best-effort cleanup of objects uploaded by this request.
      // If cleanup fails, log it so the orphaned object can be investigated.
      const cleanupResults = await Promise.allSettled(
        uploadedKeys.map((key) =>
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
            uploadedKeys[index],
            result.reason?.message || result.reason
          );
        }
      });

      next(error);
    }
  });
});

// Download only a file belonging to the authenticated user.
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

      next(error);
    }
  }
);

// Centralized API error handling.
app.use((err, req, res, next) => {
  console.error("API error:", err.name, err.message);

  if (res.headersSent) return next(err);

  const status = err instanceof multer.MulterError ? 400 : 500;

  res.status(status).json({
    success: false,
    message:
      status === 400
        ? err.message
        : "The request failed. Check the backend terminal for details."
  });
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
  console.log(`S3 bucket: ${BUCKET}`);
  console.log(`DynamoDB table: ${TABLE}`);
});
