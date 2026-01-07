import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import { promises as fs } from "fs";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import type { MessageMedia } from "@shared/schema";
import { storage, type WhatsappInstanceConfig } from "./storage";
import { MetaProvider, type MetaTemplateMessage } from "./providers/meta";
import { WebhookDebugger } from "./debug-webhook";
import { logger } from "./logger";
import type { IncomingMediaDescriptor } from "./providers/base";
import {
  ingestWhatsappMedia,
  buildSignedMediaUrlsForMessage,
} from "./services/media-pipeline";
import {
  ensureMediaDirectories,
  resolveAbsoluteMediaPath,
  extractRelativeMediaPath,
  buildSignedMediaPath,
  toRelativeMediaPath,
  toUrlPath,
} from "./services/media-storage";
import { upload } from "./services/uploads";
import { verifySignedUrl } from "./lib/signedUrl";
import {
  normalizeMimeType,
  getExtensionFromMime,
  getMimeType,
  getMimeTypeFromExtension,
} from "./lib/mime";

const MAX_PINNED_CONVERSATIONS = 10;

function resolvePublicMediaUrl(req: Request, mediaPath: string): string {
  if (!mediaPath) {
    return mediaPath;
  }

  if (/^https?:\/\//i.test(mediaPath)) {
    return mediaPath;
  }

  const configuredBase =
    process.env.MEDIA_PUBLIC_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.PUBLIC_APP_URL;

  if (configuredBase) {
    const base = configuredBase.replace(/\/+$/, "");
    const path = mediaPath.startsWith("/") ? mediaPath : `/${mediaPath}`;
    return `${base}${path}`;
  }

  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  if (!host) {
    return mediaPath;
  }

  const forwardedProto = req.get("x-forwarded-proto");
  let protocol = forwardedProto ? forwardedProto.split(",")[0]?.trim() : undefined;

  if (!protocol) {
    protocol = req.protocol;
  }

  if (!protocol) {
    protocol = "http";
  }

  protocol = protocol.replace(/:$/, "").toLowerCase();

  const path = mediaPath.startsWith("/") ? mediaPath : `/${mediaPath}`;
  return `${protocol}://${host}${path}`;
}

const getExtensionFromFilename = (filename?: string | null): string | null => {
  if (!filename) return null;
  const normalized = filename.split(".").pop();
  return normalized ? normalized.toLowerCase() : null;
};

function createPendingMediaDescriptor(descriptor?: IncomingMediaDescriptor | null): MessageMedia | null {
  if (!descriptor) {
    return null;
  }

  const inferredExtension =
    getExtensionFromMime(descriptor.mimeType) ?? getExtensionFromFilename(descriptor.filename) ?? null;

  return {
    origin: "whatsapp",
    type: descriptor.type ?? "unknown",
    status: "pending",
    provider: descriptor.provider ?? "meta",
    providerMediaId: descriptor.mediaId ?? null,
    mimeType: normalizeMimeType(descriptor.mimeType) ?? null,
    filename: descriptor.filename ?? null,
    extension: inferredExtension,
    sizeBytes: descriptor.sizeBytes ?? null,
    checksum: descriptor.sha256 ?? null,
    width: descriptor.width ?? null,
    height: descriptor.height ?? null,
    durationSeconds: descriptor.durationSeconds ?? null,
    pageCount: descriptor.pageCount ?? null,
    url: null,
    thumbnailUrl: null,
    previewUrl: null,
    placeholderUrl: null,
    storage: null,
    downloadAttempts: 0,
    downloadError: null,
    downloadedAt: null,
    thumbnailGeneratedAt: null,
    metadata: descriptor.metadata ? { whatsapp: descriptor.metadata } : null,
  };
}

function extensionToMediaType(extension: string | null): MessageMedia["type"] {
  if (!extension) return "unknown";
  const ext = extension.replace(/^\./, "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "svg"].includes(ext)) {
    return "image";
  }
  if (["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(ext)) {
    return "video";
  }
  if (["mp3", "wav", "m4a", "ogg", "aac"].includes(ext)) {
    return "audio";
  }
  if (
    [
      "pdf",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "ppt",
      "pptx",
      "txt",
      "csv",
      "zip",
      "rar",
      "7z",
    ].includes(ext)
  ) {
    return "document";
  }
  return "unknown";
}

const DEFAULT_TEMPLATE_LANGUAGE = "en_US";

type TemplateRequestInput = {
  name?: string;
  language?: string | { code?: string; policy?: "deterministic" | "fallback" };
  components?: unknown;
};

const parseTemplateComponents = (
  input: unknown,
): MetaTemplateMessage["components"] | undefined => {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    return input.filter(
      (component) => component && typeof component === "object",
    ) as MetaTemplateMessage["components"];
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (component) => component && typeof component === "object",
        ) as MetaTemplateMessage["components"];
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const parseTemplateParamsValue = (value: unknown): string[] | null => {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item)).filter((item) => item.trim().length > 0);
    return normalized.length > 0 ? normalized : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const normalized = parsed.map((item) => String(item)).filter((item) => item.trim().length > 0);
        return normalized.length > 0 ? normalized : null;
      }
    } catch {
      return [trimmed];
    }
  }

  return [trimmed];
};

const resolveTemplateParams = (templateParams: unknown, body?: string | null): string[] | null => {
  const fromParams = parseTemplateParamsValue(templateParams);
  if (fromParams && fromParams.length > 0) {
    return fromParams;
  }

  return parseTemplateParamsValue(body);
};

const buildBodyParameters = (params: string[]) =>
  params.map((text) => ({ type: "text", text }));

const applyBodyParamsToComponents = (
  components: MetaTemplateMessage["components"] | undefined,
  bodyParams: string[] | null,
): MetaTemplateMessage["components"] | undefined => {
  if (!bodyParams || bodyParams.length === 0) return components;
  const bodyComponent = { type: "body", parameters: buildBodyParameters(bodyParams) };

  if (!components || components.length === 0) return [bodyComponent];

  const next = components.map((component) => ({ ...component }));
  const bodyIndex = next.findIndex((component) => component.type === "body");

  if (bodyIndex === -1) {
    return [...next, bodyComponent];
  }

  next[bodyIndex] = {
    ...next[bodyIndex],
    parameters: buildBodyParameters(bodyParams),
  };

  return next;
};

const resolveTemplateMessage = (
  templateInput: TemplateRequestInput | string | null | undefined,
  bodyParams?: string[] | null,
): MetaTemplateMessage | null => {
  const template =
    typeof templateInput === "string"
      ? ({ name: templateInput } satisfies TemplateRequestInput)
      : (templateInput as TemplateRequestInput | null | undefined);

  const name =
    typeof template?.name === "string" && template.name.trim()
      ? template.name.trim()
      : process.env.META_TEMPLATE_NAME?.trim();

  if (!name) return null;

  const templateLanguage = template?.language;
  const languageCode =
    typeof templateLanguage === "string"
      ? templateLanguage.trim()
      : templateLanguage &&
        typeof templateLanguage === "object" &&
        typeof templateLanguage.code === "string"
      ? templateLanguage.code.trim()
      : process.env.META_TEMPLATE_LANGUAGE?.trim() || DEFAULT_TEMPLATE_LANGUAGE;

  const componentsFromRequest = parseTemplateComponents(template?.components);
  const componentsFromEnv = parseTemplateComponents(process.env.META_TEMPLATE_COMPONENTS);
  const baseComponents = componentsFromRequest ?? componentsFromEnv;
  const components = applyBodyParamsToComponents(baseComponents, bodyParams);

  const language =
    templateLanguage && typeof templateLanguage === "object"
      ? { ...templateLanguage, code: languageCode }
      : { code: languageCode };

  return {
    name,
    language,
    components,
  };
};

type TemplateCatalogItem = {
  name: string;
  language?: string;
  description?: string;
  category?: string;
  components?: MetaTemplateMessage["components"];
};

type TemplateCatalogResponseItem = TemplateCatalogItem & {
  bodyParams?: number;
};

const countBodyParams = (components?: MetaTemplateMessage["components"]): number => {
  if (!components) return 0;
  const bodyComponent = components.find((component) => component?.type === "body");
  const params = bodyComponent?.parameters;
  return Array.isArray(params) ? params.length : 0;
};

const normalizeTemplateCatalogItem = (item: unknown): TemplateCatalogResponseItem | null => {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, any>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;

  const language = typeof record.language === "string" ? record.language.trim() : undefined;
  const description = typeof record.description === "string" ? record.description.trim() : undefined;
  const category = typeof record.category === "string" ? record.category.trim() : undefined;
  const components = parseTemplateComponents(record.components);

  return {
    name,
    language,
    description,
    category,
    components,
    bodyParams: countBodyParams(components),
  };
};

const loadTemplateCatalog = (): TemplateCatalogResponseItem[] => {
  const items: TemplateCatalogResponseItem[] = [];
  const raw = process.env.META_TEMPLATE_CATALOG;

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed
          .map((item) => normalizeTemplateCatalogItem(item))
          .filter((item): item is TemplateCatalogResponseItem => Boolean(item))
          .forEach((item) => items.push(item));
      }
    } catch {
      // ignore malformed catalog
    }
  }

  if (items.length === 0) {
    const fallbackName = process.env.META_TEMPLATE_NAME?.trim();
    if (fallbackName) {
      const components = parseTemplateComponents(process.env.META_TEMPLATE_COMPONENTS);
      items.push({
        name: fallbackName,
        language: process.env.META_TEMPLATE_LANGUAGE?.trim() || DEFAULT_TEMPLATE_LANGUAGE,
        components,
        bodyParams: countBodyParams(components),
      });
    }
  }

  return items;
};

// Helper function to create a Meta provider using persisted settings (with env fallback)
async function createMetaProvider(): Promise<{
  provider: MetaProvider;
  instance: WhatsappInstanceConfig | null;
}> {
  const instance = await storage.getDefaultWhatsappInstance();

  if (instance) {
    if (instance.isActive === false) {
      throw new Error("Default WhatsApp instance is disabled.");
    }

    if (!instance.accessToken || !instance.phoneNumberId) {
      throw new Error("Default WhatsApp instance is missing required credentials.");
    }

    const provider = new MetaProvider(
      instance.accessToken,
      instance.phoneNumberId,
      instance.webhookVerifyToken ?? undefined,
      instance.appSecret ?? undefined,
      undefined,
    );

    return { provider, instance };
  }

  const provider = new MetaProvider(
    process.env.META_TOKEN,
    process.env.META_PHONE_NUMBER_ID,
    process.env.META_VERIFY_TOKEN,
    process.env.META_APP_SECRET,
    process.env.META_GRAPH_VERSION,
  );

  return { provider, instance: null };
}

const wsClients = new Set<WebSocket>();

function broadcastMessage(event: string, data: any) {
  const message = JSON.stringify({ event, data });
  wsClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function toInstanceResponse(instance: WhatsappInstanceConfig | null) {
  if (!instance) {
    return null;
  }

  return {
    id: instance.id,
    name: instance.name,
    phoneNumberId: instance.phoneNumberId,
    webhookBehavior: instance.webhookBehavior ?? "auto",
    isActive: instance.isActive ?? true,
    source: instance.source ?? "custom",
    updatedAt: instance.updatedAt ?? null,
    accessTokenConfigured: !!instance.accessToken,
    webhookVerifyTokenConfigured: !!instance.webhookVerifyToken,
    appSecretConfigured: !!instance.appSecret,
    hasAppSecret: !!instance.appSecret,
    hasVerifyToken: !!instance.webhookVerifyToken,
  };
}

  

export async function registerRoutes(app: Express, requireAdmin: any): Promise<Server> {
  // Use persistent storage for webhook events and settings (no in-memory state)

  ensureMediaDirectories();

  const normalizeWebhookPath = (inputPath: string): string => {
    const fallback = "/webhook/meta";
    if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
      return fallback;
    }

    let normalized = inputPath.trim();

    if (!normalized.startsWith("/")) {
      normalized = `/${normalized}`;
    }

    normalized = normalized.replace(/\/{2,}/g, "/");

    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.replace(/\/+$/, "");
    }

    if (!normalized.startsWith("/webhook")) {
      normalized = `/webhook${normalized === "/" ? "" : normalized}`;
    }

    return normalized || fallback;
  };

  const normalizeForComparison = (value: string): string => {
    if (!value) return "/";
    let normalized = value.startsWith("/") ? value : `/${value}`;
    normalized = normalized.replace(/\/{2,}/g, "/");
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.replace(/\/+$/, "");
    }
    return normalized || "/";
  };

  const metaWebhookSettings = await storage.getMetaWebhookSettings();
  let metaWebhookPath = normalizeWebhookPath(metaWebhookSettings.path);

  const pathsMatchMetaWebhook = (pathToCheck: string) =>
    normalizeForComparison(pathToCheck) === normalizeForComparison(metaWebhookPath);

  const updateMetaWebhookPath = (nextPath: string) => {
    metaWebhookPath = normalizeWebhookPath(nextPath);
  };

  // Admin endpoint to get/set API controls (persisted)
  app.get('/api/admin/api-controls', requireAdmin, async (req: Request, res: Response) => {
    const v = await storage.getAppSetting('apiControls');
    res.json(v || { testWebhookEnabled: true });
  });

  app.post('/api/admin/api-controls', requireAdmin, async (req: Request, res: Response) => {
    const { testWebhookEnabled } = req.body as { testWebhookEnabled?: boolean };
    const current = (await storage.getAppSetting('apiControls')) || { testWebhookEnabled: true };
    if (typeof testWebhookEnabled === 'boolean') current.testWebhookEnabled = testWebhookEnabled;
    await storage.setAppSetting('apiControls', current);
    res.json(current);
  });

  app.get("/api/admin/webhook-config", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const config = await storage.getMetaWebhookSettings();
      res.json({ config });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/admin/webhook-config", requireAdmin, async (req: Request, res: Response) => {
    try {
      const requestedPath = typeof req.body?.path === "string" ? req.body.path : "";
      if (!requestedPath.trim()) {
        return res.status(400).json({ error: "Path is required." });
      }

      const sanitizedPath = normalizeWebhookPath(requestedPath);
      await storage.setMetaWebhookSettings({ path: sanitizedPath });
      updateMetaWebhookPath(sanitizedPath);

      const updated = await storage.getMetaWebhookSettings();
      res.json({ config: updated });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/admin/whatsapp/default-instance', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const instance = await storage.getDefaultWhatsappInstance();
      res.json({ instance: toInstanceResponse(instance) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/admin/whatsapp/default-instance', requireAdmin, async (req: Request, res: Response) => {
    try {
      const current = await storage.getDefaultWhatsappInstance();
      const {
        name,
        phoneNumberId,
        accessToken,
        webhookVerifyToken,
        appSecret,
        webhookBehavior,
        isActive,
      } = req.body as Partial<{
        name: string;
        phoneNumberId: string;
        accessToken: string;
        webhookVerifyToken: string | null;
        appSecret: string | null;
        webhookBehavior: "auto" | "accept" | "reject";
        isActive: boolean;
      }>;

      const trimmedName = typeof name === "string" ? name.trim() : undefined;
      const trimmedPhoneNumberId = typeof phoneNumberId === "string" ? phoneNumberId.trim() : undefined;
      const trimmedAccessToken = typeof accessToken === "string" ? accessToken.trim() : undefined;

      const resolvedName =
        (trimmedName && trimmedName.length > 0
          ? trimmedName
          : current?.name) || "Default WhatsApp Instance";
      const resolvedPhoneNumberId =
        (trimmedPhoneNumberId && trimmedPhoneNumberId.length > 0
          ? trimmedPhoneNumberId
          : current?.phoneNumberId) || "";

      if (!resolvedPhoneNumberId) {
        return res.status(400).json({ error: "Phone Number ID is required." });
      }

      if (trimmedAccessToken === "") {
        return res.status(400).json({ error: "Access token cannot be empty." });
      }

      const resolvedAccessToken =
        trimmedAccessToken && trimmedAccessToken.length > 0
          ? trimmedAccessToken
          : current?.accessToken || "";

      if (!resolvedAccessToken) {
        return res.status(400).json({ error: "Access token is required." });
      }

      let resolvedVerifyToken = current?.webhookVerifyToken ?? null;
      if (webhookVerifyToken !== undefined) {
        if (webhookVerifyToken === null) {
          resolvedVerifyToken = null;
        } else if (typeof webhookVerifyToken === "string") {
          const trimmed = webhookVerifyToken.trim();
          resolvedVerifyToken = trimmed.length > 0 ? trimmed : null;
        }
      }

      let resolvedAppSecret = current?.appSecret ?? null;
      if (appSecret !== undefined) {
        if (appSecret === null) {
          resolvedAppSecret = null;
        } else if (typeof appSecret === "string") {
          const trimmed = appSecret.trim();
          resolvedAppSecret = trimmed.length > 0 ? trimmed : null;
        }
      }

      const allowedBehaviors: Array<"auto" | "accept" | "reject"> = ["auto", "accept", "reject"];
      const resolvedBehavior =
        typeof webhookBehavior === "string" && allowedBehaviors.includes(webhookBehavior)
          ? webhookBehavior
          : current?.webhookBehavior || "auto";

      const resolvedIsActive =
        typeof isActive === "boolean" ? isActive : current?.isActive ?? true;

      await storage.setDefaultWhatsappInstance({
        id: "default",
        name: resolvedName,
        phoneNumberId: resolvedPhoneNumberId,
        accessToken: resolvedAccessToken,
        webhookVerifyToken: resolvedVerifyToken,
        appSecret: resolvedAppSecret,
        webhookBehavior: resolvedBehavior,
        isActive: resolvedIsActive,
      });

      const updated = await storage.getDefaultWhatsappInstance();
      res.json({ instance: toInstanceResponse(updated) });
    } catch (error: any) {
      console.error("Failed to update default WhatsApp instance:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Admin endpoint to clear webhook events
  app.post('/api/webhooks/clear', requireAdmin, async (_req: Request, res: Response) => {
    await storage.deleteWebhookEvents();
    res.json({ ok: true });
  });

  // Admin endpoints to inspect webhook events and configure behavior
  app.get('/api/webhooks/events', requireAdmin, async (req: Request, res: Response) => {
    const { webhookId } = req.query;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const items = await storage.getWebhookEvents(
      limit && Number.isFinite(limit) ? limit : undefined,
      typeof webhookId === "string" && webhookId.trim().length > 0
        ? { webhookId: webhookId.trim() }
        : undefined
    );
    res.json({ items });
  });

  // Delete a single webhook event
  app.delete('/api/webhooks/events/:id', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    await storage.deleteWebhookEventById(id);
    res.json({ ok: true });
  });

  // Bulk delete events for instance
  app.delete('/api/webhooks/events', requireAdmin, async (req: Request, res: Response) => {
    await storage.deleteWebhookEvents();
    res.json({ ok: true });
  });

  // Admin data editor endpoints (read lists)
  app.get('/api/admin/users', requireAdmin, async (_req: Request, res: Response) => {
    const items = await storage.getAllUsers();
    res.json(items.map(({ password, ...u }) => u));
  });


  app.get('/api/admin/webhooks', requireAdmin, async (req: Request, res: Response) => {
    const hooks = await storage.getAllWebhooks();
    res.json(hooks);
  });

  app.get("/api/admin/ready-messages", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const items = await storage.getReadyMessages(false);
      res.json({ items });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/ready-messages", requireAdmin, async (req: Request, res: Response) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
      const isActive = typeof req.body?.isActive === "boolean" ? req.body.isActive : true;

      if (!name) {
        return res.status(400).json({ error: "Name is required." });
      }

      if (!body) {
        return res.status(400).json({ error: "Message body is required." });
      }

      const item = await storage.createReadyMessage({
        name,
        body,
        isActive,
        createdByUserId: req.user?.id ?? null,
      });

      res.status(201).json({ item });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/admin/ready-messages/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updates: { name?: string; body?: string; isActive?: boolean } = {};

      if (typeof req.body?.name === "string") {
        const trimmedName = req.body.name.trim();
        if (!trimmedName) {
          return res.status(400).json({ error: "Name cannot be empty." });
        }
        updates.name = trimmedName;
      }

      if (typeof req.body?.body === "string") {
        const trimmedBody = req.body.body.trim();
        if (!trimmedBody) {
          return res.status(400).json({ error: "Message body cannot be empty." });
        }
        updates.body = trimmedBody;
      }

      if (typeof req.body?.isActive === "boolean") {
        updates.isActive = req.body.isActive;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No updates provided." });
      }

      const item = await storage.updateReadyMessage(id, updates);

      if (!item) {
        return res.status(404).json({ error: "Ready message not found." });
      }

      res.json({ item });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/admin/ready-messages/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await storage.deleteReadyMessage(id);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Admin update endpoints
  app.patch('/api/admin/users/:id', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const updates = req.body;
    const user = await storage.adminUpdateUser(id, updates);
    const { password: _, ...userWithoutPassword } = user;
    res.json(userWithoutPassword);
  });


  app.patch('/api/admin/webhooks/:id', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const updates = req.body;
    const hook = await storage.adminUpdateWebhook(id, updates);
    res.json(hook);
  });

  app.get("/media/*", async (req: Request, res: Response) => {
    const validation = verifySignedUrl(req);
    if (!validation.valid) {
      return res.status(validation.status).json({ error: validation.message });
    }

    const relativePath = req.params[0];
    if (!relativePath) {
      return res.status(404).json({ error: "Not found" });
    }

    try {
      const absolutePath = resolveAbsoluteMediaPath(relativePath);
      await fs.access(absolutePath);

      const extension = path.extname(absolutePath).replace(/^\./, "");
      const mime = getMimeTypeFromExtension(extension) ?? getMimeType(extension);

      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("Content-Type", mime ?? "application/octet-stream");
      res.setHeader("Content-Disposition", "inline");

      res.sendFile(absolutePath, (error) => {
        if (error) {
          if (!res.headersSent) {
            const status = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? 404 : 500;
            res.status(status).end();
          }
        }
      });
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return res.status(404).json({ error: "Not found" });
      }

      logger.error({ err: error, relativePath }, "Failed to serve media file");
      return res.status(500).json({ error: "Failed to serve media" });
    }
  });

  app.get("/api/conversations/pins", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const pins = await storage.getPinnedConversationsForUser(req.user.id);
      res.json({ pins });
    } catch (error: any) {
      logger.error({ err: error }, "failed to get pinned conversations");
      res.status(500).json({ error: error?.message ?? "Failed to load pinned conversations" });
    }
  });

  app.post("/api/conversations/:id/pin", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const conversationId = req.params.id;
      if (!conversationId) {
        return res.status(400).json({ error: "Conversation id is required." });
      }

      const bodyPinned = req.body?.pinned;
      if (typeof bodyPinned !== "boolean") {
        return res.status(400).json({ error: "pinned must be a boolean." });
      }

      const conversation = await storage.getConversationById(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found." });
      }

      const userId = req.user.id;

      if (bodyPinned) {
        const alreadyPinned = await storage.isConversationPinned(userId, conversationId);
        if (!alreadyPinned) {
          const currentCount = await storage.countPinnedConversations(userId);
          if (currentCount >= MAX_PINNED_CONVERSATIONS) {
            return res.status(400).json({ error: "You can only pin up to 10 chats." });
          }
        }

        await storage.pinConversation(userId, conversationId);
      } else {
        await storage.unpinConversation(userId, conversationId);
      }

      const pins = await storage.getPinnedConversationsForUser(userId);
      res.json({ pinned: bodyPinned, pins });
    } catch (error: any) {
      logger.error({ err: error }, "failed to toggle pin state");
      res.status(500).json({ error: error?.message ?? "Failed to update pin state" });
    }
  });

  // File upload endpoint
  app.post("/api/upload", upload.single("file"), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const relativePath = toRelativeMediaPath([
        "outbound",
        "original",
        req.file.filename,
      ]);
      const unsignedPath = toUrlPath(relativePath);
      const signedPath = buildSignedMediaPath(relativePath);
      const publicUrl = resolvePublicMediaUrl(req, signedPath);

      let expiresAt: number | undefined;
      try {
        const signedUrl = new URL(signedPath, "https://placeholder.local");
        const expires = signedUrl.searchParams.get("expires");
        if (expires) {
          expiresAt = Number(expires);
        }
      } catch {
        expiresAt = undefined;
      }

      res.json({
        url: signedPath,
        publicUrl,
        relativePath,
        unsignedUrl: unsignedPath,
        expiresAt,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/conversations", async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = parseInt(req.query.page_size as string) || 20;
      const archived = req.query.archived === "true";
      const result = await storage.getConversations(page, pageSize, archived);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/conversations/:id/archive", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { archived } = req.body;
      
      if (typeof archived !== "boolean") {
        return res.status(400).json({ error: "archived must be a boolean" });
      }

      const conversation = await storage.toggleConversationArchive(id, archived);
      res.json(conversation);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = parseInt(req.query.page_size as string) || 50;
      const result = await storage.getMessages(id, page, pageSize);
      const signedItems = result.items.map((item) => buildSignedMediaUrlsForMessage(item));
      res.json({ ...result, items: signedItems });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/conversations/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: "Conversation id is required" });
      }

      await storage.deleteConversation(id);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/conversations", async (req: Request, res: Response) => {
    try {
      const { phone, displayName } = req.body as {
        phone?: string;
        displayName?: string | null;
      };

      const trimmedPhone = typeof phone === "string" ? phone.trim() : "";
      if (!trimmedPhone) {
        return res.status(400).json({ error: "Phone number is required." });
      }

      let conversation = await storage.getConversationByPhone(trimmedPhone);
      let created = false;

      if (!conversation) {
        conversation = await storage.createConversation({
          phone: trimmedPhone,
          displayName: typeof displayName === "string" ? displayName.trim() || null : null,
          createdByUserId: req.user?.id ?? null,
        });
        created = true;
      }

      res.json({ conversation, created });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });


  // Webhook CRUD (admin)
  app.get('/api/webhooks', requireAdmin, async (req: Request, res: Response) => {
    const hooks = await storage.getAllWebhooks();
    res.json(hooks);
  });

  app.post('/api/webhooks', requireAdmin, async (req: Request, res: Response) => {
    const { name, url, verifyToken, isActive } = req.body;
    const hook = await storage.createWebhook({ name, url, verifyToken, isActive });
    res.json(hook);
  });

  app.put('/api/webhooks/:id', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const updates = req.body;
    const hook = await storage.updateWebhook(id, updates);
    res.json(hook);
  });

  app.delete('/api/webhooks/:id', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    await storage.deleteWebhook(id);
    res.json({ ok: true });
  });

  app.post("/api/activity/ping", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).send("Not authenticated");
    }

    try {
      await storage.recordUserActivity(req.user.id);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });


  app.get("/api/statistics", async (req: Request, res: Response) => {
    try {
      const stats = await storage.getStatistics();
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/templates", async (_req: Request, res: Response) => {
    try {
      const items = loadTemplateCatalog();
      res.json({ items });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/ready-messages", async (_req: Request, res: Response) => {
    try {
      const items = await storage.getReadyMessages(true);
      res.json({ items });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/message/send", async (req: Request, res: Response) => {
    try {
      const {
        to,
        body,
        media_url,
        conversationId,
        replyToMessageId,
        messageType,
        template,
        templateParams,
      } = req.body as {
        to?: string;
        body?: string | null;
        media_url?: string | null;
        conversationId?: string | null;
        replyToMessageId?: string | null;
        messageType?: "text" | "template";
        template?: TemplateRequestInput | string | null;
        templateParams?: string[] | string | null;
      };

      if (!conversationId && !to) {
        return res.status(400).json({ error: "conversationId or to is required." });
      }

      const wantsTemplate = messageType === "template" || Boolean(template);

      if (!wantsTemplate && !body && !media_url) {
        return res.status(400).json({ error: "body or media_url is required." });
      }

      if (wantsTemplate && media_url) {
        return res.status(400).json({ error: "template messages do not support media_url." });
      }

      let conversation = null as Awaited<ReturnType<typeof storage.getConversationById>> | null;

      if (conversationId) {
        conversation = await storage.getConversationById(conversationId);
        if (!conversation) {
          return res.status(404).json({ error: "Conversation not found." });
        }
      }

      if (!conversation) {
        if (!to) {
          return res.status(400).json({ error: "Recipient phone number is required." });
        }

        conversation = await storage.getConversationByPhone(to);

        if (!conversation) {
          conversation = await storage.createConversation({
            phone: to,
            createdByUserId: req.user?.id ?? null,
          });
        }
      }

      const recipientPhone = conversation.phone;
      const resolvedTemplateParams = wantsTemplate ? resolveTemplateParams(templateParams, body ?? null) : null;
      const templateMessage = wantsTemplate
        ? resolveTemplateMessage(template, resolvedTemplateParams)
        : null;

      if (wantsTemplate && !templateMessage) {
        return res.status(400).json({
          error: "Template name is required. Set META_TEMPLATE_NAME or pass template.name in the request.",
        });
      }

      let replyTarget = null as Awaited<ReturnType<typeof storage.getMessageById>> | null;
      let replyToProviderMessageId: string | null = null;

      if (replyToMessageId) {
        const messageTarget = await storage.getMessageById(replyToMessageId);

        if (!messageTarget) {
          return res.status(400).json({ error: "Reply target not found." });
        }

        if (messageTarget.conversationId !== conversation.id) {
          return res.status(400).json({ error: "Reply target belongs to a different conversation." });
        }

        replyTarget = messageTarget;
        replyToProviderMessageId = messageTarget.providerMessageId ?? null;
      }

      console.info(
        "message_send_attempt",
        JSON.stringify({
          conversationId: conversation.id,
          replyToMessageId: replyToMessageId ?? null,
          hasMedia: Boolean(media_url),
          messageType: wantsTemplate ? "template" : "text",
        }),
      );

      const relativeMediaPath = media_url ? extractRelativeMediaPath(media_url) : null;
      const inferredFilename = relativeMediaPath
        ? path.basename(relativeMediaPath)
        : media_url
        ? path.basename(media_url.split("?")[0].split("#")[0])
        : null;
      const extension = getExtensionFromFilename(inferredFilename);
      const outboundMediaType = extensionToMediaType(extension);
      const inferredMime =
        (extension ? getMimeTypeFromExtension(extension) : null) ??
        (extension ? getMimeType(extension) : null);

      const outboundMedia: MessageMedia | null = media_url
        ? {
            origin: "upload",
            type: outboundMediaType,
            status: "ready",
            provider: "local",
            providerMediaId: null,
            mimeType: inferredMime,
            filename: inferredFilename,
            extension,
            sizeBytes: null,
            checksum: null,
            width: null,
            height: null,
            durationSeconds: null,
            pageCount: null,
            url: relativeMediaPath ? toUrlPath(relativeMediaPath) : media_url.split("?")[0],
            thumbnailUrl: null,
            previewUrl: null,
            placeholderUrl: null,
            storage: relativeMediaPath
              ? {
                  originalPath: relativeMediaPath,
                  thumbnailPath: null,
                  previewPath: null,
                }
              : null,
            downloadAttempts: 0,
            downloadError: null,
            downloadedAt: new Date().toISOString(),
            thumbnailGeneratedAt: null,
            metadata: {
              origin: "upload",
            },
          }
        : null;

      const { provider } = await createMetaProvider();
      let providerMessageId: string | null = null;
      let status: string = "sent";
      const providerMediaPath = relativeMediaPath ? buildSignedMediaPath(relativeMediaPath) : media_url ?? undefined;
      const storedBody = wantsTemplate
        ? body && body.trim().length > 0
          ? body.trim()
          : resolvedTemplateParams && resolvedTemplateParams.length > 0
          ? `Template: ${templateMessage?.name ?? "unknown"} (${resolvedTemplateParams.join(", ")})`
          : `Template: ${templateMessage?.name ?? "unknown"}`
        : body || null;

      const providerOptions = replyToProviderMessageId
        ? { replyToMessageId: replyToProviderMessageId }
        : undefined;

      try {
        if (wantsTemplate && templateMessage) {
          const providerResp = await provider.sendTemplate(recipientPhone, templateMessage, providerOptions);
          providerMessageId = providerResp.id || null;
        } else {
          const providerMediaUrl = providerMediaPath
            ? resolvePublicMediaUrl(req, providerMediaPath)
            : undefined;

          const providerResp = await provider.send(
            recipientPhone,
            body ?? undefined,
            providerMediaUrl,
            providerOptions,
          );
          providerMessageId = providerResp.id || null;
        }
      } catch (providerError: any) {
        console.warn("Failed to send via provider, saving locally:", providerError.message);
        status = "failed";
      }

      const message = await storage.createMessage({
        conversationId: conversation.id,
        direction: "outbound",
        body: storedBody,
        media: outboundMedia,
        providerMessageId,
        status,
        raw: wantsTemplate ? { template: templateMessage, params: resolvedTemplateParams } : undefined,
        replyToMessageId: replyToMessageId ?? null,
        sentByUserId: req.user?.id ?? null,
      } as any);

      await storage.updateConversationLastAt(conversation.id);

      const messageWithReply = await storage.getMessageWithReplyById(message.id);
      const payload = buildSignedMediaUrlsForMessage(messageWithReply ?? message);

      res.json({ ok: true, message: payload });

      broadcastMessage("message_outgoing", payload);

      console.info(
        "message_sent_reply",
        JSON.stringify({
          messageId: message.id,
          conversationId: conversation.id,
          replyToMessageId: replyToMessageId ?? null,
          validReply: Boolean(replyTarget),
        }),
      );
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/messages/:id", requireAdmin, async (_req: Request, res: Response) => {
    res.status(403).json({ error: "Message deletion is disabled." });
  });

  // Meta webhook verification (GET request)
  const handleMetaWebhookVerification = async (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const challenge = req.query["hub.challenge"];
    const verifyToken = req.query["hub.verify_token"];

    const isVerificationAttempt =
      typeof mode === "string" &&
      mode.toLowerCase() === "subscribe" &&
      typeof challenge === "string";

    if (!isVerificationAttempt) {
      return res
        .status(200)
        .send(
          "Meta webhook endpoint is online. To verify, Meta will call this URL with hub.mode=subscribe, hub.verify_token, and hub.challenge query parameters."
        );
    }

    try {
      const { provider, instance } = await createMetaProvider();
      const expectedToken =
        instance?.webhookVerifyToken ??
        process.env.META_VERIFY_TOKEN ??
        "";

      if (!expectedToken) {
        console.warn("Webhook verification attempted but no verify token is configured.");
        await storage.logWebhookEvent({
          headers: req.headers,
          query: req.query,
          body: null,
          response: { status: 500, body: "Missing verify token configuration" },
        });
        return res
          .status(500)
          .send(
            "Verify token is not configured. Set META_VERIFY_TOKEN or update the Default WhatsApp Instance."
          );
      }

      if (verifyToken !== expectedToken) {
        console.warn(
          `Webhook verification failed: provided token "${verifyToken}" does not match configured token.`
        );
        await storage.logWebhookEvent({
          headers: req.headers,
          query: req.query,
          body: null,
          response: { status: 403, body: "Forbidden" },
        });
        return res.status(403).send("Forbidden");
      }

      await storage.logWebhookEvent({
        headers: req.headers,
        query: req.query,
        body: null,
        response: { status: 200, body: String(challenge) },
      });
      res.status(200).send(challenge);
    } catch (error: any) {
      console.error("Webhook verification error:", error);
      await storage.logWebhookEvent({
        headers: req.headers,
        query: req.query,
        body: null,
        response: { status: 500, body: error.message },
      });
      res.status(500).send("Error");
    }
  };


  // Meta webhook for incoming messages (POST request)
  const handleMetaWebhookEvent = async (req: Request, res: Response) => {
    const startTime = Date.now();
    
    logger.debug(
      { event: "meta_webhook_received", path: req.path },
      "Meta webhook received",
    );
    
    try {
      const { provider, instance } = await createMetaProvider();
      
      // Verify webhook signature if app secret is configured
      const hasAppSecret = !!(instance?.appSecret || process.env.META_APP_SECRET);
      if (hasAppSecret) {
        logger.debug(
          { event: "meta_webhook_signature_check" },
          "Verifying webhook signature",
        );
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const signatureValid = (provider as any).verifyWebhookSignature(req, rawBody);
        
        if (!signatureValid) {
          logger.warn(
            { event: "meta_webhook_signature_invalid" },
            "Invalid webhook signature",
          );
          await storage.logWebhookEvent({
            headers: req.headers,
            query: req.query,
            body: req.body,
            response: { status: 401, body: 'Invalid signature' },
          });
          return res.status(401).send("Invalid signature");
        }
        logger.debug(
          { event: "meta_webhook_signature_valid" },
          "Webhook signature verified",
        );
      } else {
        logger.debug(
          { event: "meta_webhook_signature_skipped" },
          "No app secret configured, skipping signature verification",
        );
      }

      const events = provider.parseIncoming(req.body);

      if (events.length === 0) {
        logger.debug(
          { event: "meta_webhook_no_events" },
          "No message events in payload",
        );
        await storage.logWebhookEvent({
          headers: req.headers,
          query: req.query,
          body: req.body,
          response: { status: 200, body: 'ok - no events' },
        });
        return res.status(200).send("ok - no events");
      }

      let processedCount = 0;

      for (const event of events) {
        if (event.providerMessageId) {
          const existing = await storage.getMessageByProviderMessageId(event.providerMessageId);
          if (existing) {
            logger.info(
              {
                providerMessageId: event.providerMessageId,
                existingMessageId: existing.id,
                conversationId: existing.conversationId,
              },
              "Skipping duplicate webhook message",
            );
            continue;
          }
        }

        let conversation = await storage.getConversationByPhone(event.from);
        if (!conversation) {
          conversation = await storage.createConversation({
            phone: event.from,
          });
        }

        if (conversation.archived) {
          conversation = await storage.toggleConversationArchive(conversation.id, false);
        }

        const pendingMedia = createPendingMediaDescriptor(event.media);
        let replyToId: string | null = null;

        if (event.replyToProviderMessageId) {
          const replyTarget = await storage.getMessageByProviderMessageId(event.replyToProviderMessageId);
          if (replyTarget && replyTarget.conversationId === conversation.id) {
            replyToId = replyTarget.id;
          }
        }

        const message = await storage.createMessage({
          conversationId: conversation.id,
          direction: "inbound",
          body: event.body ?? null,
          media: pendingMedia,
          providerMessageId: event.providerMessageId ?? null,
          status: "received",
          raw: event.raw,
          replyToMessageId: replyToId,
        } as any);
        processedCount += 1;

        await storage.logWebhookEvent({
          headers: req.headers,
          query: req.query,
          body: event.raw || event,
          response: { status: 200, body: 'ok', messageId: message.id },
        });

        await storage.updateConversationLastAt(conversation.id);
        const signedMessage = buildSignedMediaUrlsForMessage(message);
        broadcastMessage("message_incoming", signedMessage);

        if (event.media) {
          ingestWhatsappMedia({
            messageId: message.id,
            conversationId: conversation.id,
            descriptor: event.media,
            provider,
            onStatusChange: async (updated) => {
              if (!updated) return;
              const signed = buildSignedMediaUrlsForMessage(updated);
              broadcastMessage("message_media_updated", signed);
            },
          }).catch((error: any) => {
            logger.error(
              {
                err: error,
                conversationId: conversation.id,
                messageId: message.id,
                providerMessageId: event.providerMessageId,
              },
              "Error ingesting WhatsApp media",
            );
          });
        }
      }

      const duration = Date.now() - startTime;
      logger.info(
        {
          event: "meta_webhook_processed",
          messageCount: processedCount,
          durationMs: duration,
        },
        "Meta webhook processed",
      );
      res.status(200).send("ok");
    } catch (error: any) {
      const duration = Date.now() - startTime;
      logger.error(
        { err: error, event: "meta_webhook_error", durationMs: duration },
        "Meta webhook error",
      );
      
      await storage.logWebhookEvent({
        headers: req.headers,
        query: req.query,
        body: req.body,
        response: { 
          status: 500, 
          body: error.message,
          error: error.stack 
        },
      });
      
      res.status(500).json({ error: error.message });
    }
  };

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!pathsMatchMetaWebhook(req.path)) {
      return next();
    }

    if (req.method === "GET") {
      return handleMetaWebhookVerification(req, res);
    }

    if (req.method === "POST") {
      return handleMetaWebhookEvent(req, res);
    }

    return res.status(405).json({ error: "Method Not Allowed" });
  });

  // Debug webhook endpoint - for testing and debugging webhook issues
  app.post("/webhook/debug", async (req: Request, res: Response) => {
    try {
      logger.debug({ event: "debug_webhook_called" }, "Debug webhook called");
      
      const debugInfo = await WebhookDebugger.debugWebhookFlow(
        'default',
        req.body,
        req.headers,
        req.query
      );
      
      res.json({
        success: true,
        debugInfo,
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      logger.error({ err: error, event: "debug_webhook_error" }, "Debug webhook error");
      res.status(500).json({ 
        success: false,
        error: error.message,
        stack: error.stack
      });
    }
  });

  // Webhook status endpoint - check webhook configuration and recent events
  app.get("/api/webhook/status", requireAdmin, async (req: Request, res: Response) => {
    try {
      // Get recent webhook events
      const recentEvents = await storage.getWebhookEvents(10);
      
      // Get webhook URL
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const webhookUrl = `${baseUrl}/webhook/meta`;
      
      const instance = await storage.getDefaultWhatsappInstance();
      const instanceResponse = toInstanceResponse(instance);
      const isConfigured = !!(instance?.accessToken && instance?.phoneNumberId);
      const hasWebhookSecret = !!instance?.appSecret;
      const hasVerifyToken = !!instance?.webhookVerifyToken;
      const isActive = instance?.isActive ?? true;
      const webhookBehavior = instance?.webhookBehavior ?? "auto";

      res.json({
        instance: instanceResponse
          ? {
              ...instanceResponse,
              webhookUrl,
            }
          : {
              id: "default",
              name: "Default WhatsApp Instance",
              isActive: false,
              webhookBehavior: "auto",
              hasAppSecret: false,
              hasVerifyToken: false,
              webhookUrl,
              accessTokenConfigured: false,
              webhookVerifyTokenConfigured: false,
              appSecretConfigured: false,
              source: "env",
              updatedAt: null,
              phoneNumberId: "",
            },
        recentEvents: recentEvents.map(event => ({
          id: event.id,
          createdAt: event.createdAt,
          headers: event.headers,
          query: event.query,
          body: event.body,
          response: event.response
        })),
        status: {
          isConfigured,
          hasWebhookSecret,
          hasVerifyToken,
          isActive,
          webhookBehavior
        }
      });
    } catch (error: any) {
      console.error("Webhook status error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Test message endpoint - send a test message to verify the system works
  app.post("/api/test-message", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { to, body } = req.body;
      
      if (!to || !body) {
        return res.status(400).json({ error: "to and body are required" });
      }

      const { provider, instance } = await createMetaProvider();
      
      logger.info({ event: "test_message_send", to }, "Sending test message");
      const result = await provider.send(to, body);
      
      res.json({
        success: true,
        message: "Test message sent successfully",
        result,
        instance: instance
          ? {
              id: instance.id,
              name: instance.name,
              phoneNumberId: instance.phoneNumberId,
              source: instance.source,
            }
          : {
              id: "default",
              name: "Default WhatsApp Instance",
            },
      });
    } catch (error: any) {
      logger.error({ err: error, event: "test_message_error" }, "Test message error");
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  });

  // Test webhook endpoint - accepts simple payloads for local testing
  // Body shape: { from: string, body?: string, media?: any, instanceId?: string }
  app.post("/webhook/test", async (req: Request, res: Response) => {
    try {
      const apiControls = (await storage.getAppSetting('apiControls')) || { testWebhookEnabled: true };
      if (!apiControls.testWebhookEnabled) {
        return res.status(403).json({ error: 'Test webhooks are disabled' });
      }
      const { from, body: textBody, media } = req.body as any;

      if (!from) {
        return res.status(400).json({ error: "'from' (phone) is required" });
      }

      let conversation = await storage.getConversationByPhone(from);

      // If no conversation exists, create one
      if (!conversation) {
        conversation = await storage.createConversation({
          phone: from,
        });
      }

      if (conversation.archived) {
        conversation = await storage.toggleConversationArchive(conversation.id, false);
      }

      const message = await storage.createMessage({
        conversationId: conversation.id,
        direction: "inbound",
        body: textBody || null,
        media: media || null,
        status: "received",
        raw: req.body,
        replyToMessageId: null,
      } as any);

      await storage.updateConversationLastAt(conversation.id);

      // persist the test webhook event
      await storage.logWebhookEvent({
        headers: req.headers as any,
        query: req.query as any,
        body: req.body,
        response: { status: 200, body: 'ok' },
      });

      broadcastMessage("message_incoming", message);

      res.json({ ok: true, message });
    } catch (error: any) {
      console.error("Test webhook error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  const httpServer = createServer(app);

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    console.debug('WebSocket client connected');
    wsClients.add(ws);

    ws.on('close', () => {
      console.debug('WebSocket client disconnected');
      wsClients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      wsClients.delete(ws);
    });
  });

  return httpServer;
}
