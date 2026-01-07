import express, { type Request, Response, NextFunction } from "express";
import { mkdirSync } from "fs";
import { join } from "path";
import http from "http";

import { env } from "../validate-env";
import { registerRoutes } from "./routes";
import { setupAuth } from "./auth";
import { setupVite, serveStatic } from "./vite";
import { httpLogger, logger } from "./logger";
import { registerHealthRoute } from "./health";
import { assertSigningSecret } from "./lib/signedUrl";

// Ensure uploads directory exists
try {
  mkdirSync(join(process.cwd(), "uploads"), { recursive: true });
} catch {
  // ignore
}

const app = express();

/* ===============================
   App & Environment Setup
================================ */
process.env.NODE_ENV = env.NODE_ENV;
app.set("env", env.NODE_ENV);
app.set("trust proxy", true);

app.use(httpLogger);

assertSigningSecret();

/* ===============================
   HTTPS Enforcement (optional)
================================ */
const enforceHttps = env.ENFORCE_HTTPS ?? false;

if (enforceHttps) {
  app.use((req, res, next) => {
    const forwardedProto = req.get("x-forwarded-proto");
    const primaryProto = forwardedProto?.split(",")[0]?.trim().toLowerCase();
    const isHttps = req.secure || primaryProto === "https";
    const upgradeHeader = req.get("upgrade");

    if (isHttps || (upgradeHeader && upgradeHeader.toLowerCase() === "websocket")) {
      return next();
    }

    const host = req.get("host");
    if (!host) return next();

    return res.redirect(301, `https://${host}${req.originalUrl}`);
  });
}

/* ===============================
   Body Parsers (with webhook raw)
================================ */
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      if (req.path.startsWith("/webhook/")) {
        req.rawBody = buf.toString("utf8");
      }
    },
  })
);

app.use(
  express.urlencoded({
    extended: false,
    verify: (req: any, _res, buf) => {
      if (req.path.startsWith("/webhook/")) {
        req.rawBody = buf.toString("utf8");
      }
    },
  })
);

/* ===============================
   Health & Auth
================================ */
registerHealthRoute(app);
const { requireAdmin } = setupAuth(app);

/* ===============================
   API Logger
================================ */
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: any;
  const shouldIncludePreview =
    typeof logger.isLevelEnabled === "function"
      ? logger.isLevelEnabled("debug")
      : env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace";

  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    capturedJsonResponse = body;
    return originalJson(body);
  };

  res.on("finish", () => {
    if (path.startsWith("/api")) {
      logger.info(
        {
          event: "api_request_completed",
          method: req.method,
          path,
          statusCode: res.statusCode,
          durationMs: Date.now() - start,
          responsePreview:
            shouldIncludePreview && capturedJsonResponse
              ? JSON.stringify(capturedJsonResponse).slice(0, 200)
              : undefined,
        },
        "API request completed"
      );
    }
  });

  next();
});

/* ===============================
   Bootstrap Server
================================ */
(async () => {
  // Ensure DB schema exists
  const { ensureSchema } = await import("./db");
  await ensureSchema();

  // Register routes (returns http.Server)
  const server = await registerRoutes(app, requireAdmin);

  /* ===============================
     Error Handler
  ================================ */
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err.name === "MulterError") {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large. Maximum size is 10MB." });
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ error: "Unexpected file field." });
      }
      return res.status(400).json({ error: err.message });
    }

    const status = err.status || err.statusCode || 500;
    res.status(status).json({ message: err.message || "Internal Server Error" });
    logger.error(err);
  });

  /* ===============================
     Vite / Static
  ================================ */
  if (env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  /* ===============================
     Listen (Windows-safe)
  ================================ */
  const port = env.PORT;

  const host =
    env.HOST ??
    (process.platform === "win32" ? "127.0.0.1" : "0.0.0.0");

  const listenOptions =
    process.platform === "win32"
      ? { port, host }
      : { port, host, reusePort: true as const };

  server.listen(listenOptions as any, () => {
    logger.info(
      { event: "server_started", port, host },
      `Serving on http://${host}:${port}`
    );
  });
})();
