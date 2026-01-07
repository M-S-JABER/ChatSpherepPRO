import {
  IWhatsAppProvider,
  SendMessageResponse,
  SendMessageOptions,
  IncomingMessageEvent,
  IncomingMediaDescriptor,
  IncomingMediaType,
} from "./base";
import crypto from "crypto";
import path from "path";
import { logger } from "../logger";

export type MetaTemplateComponentParameter = {
  type: "text" | "currency" | "date_time" | "image" | "video" | "document" | "payload";
  text?: string;
  currency?: {
    fallback_value: string;
    code: string;
    amount_1000: number;
  };
  date_time?: {
    fallback_value: string;
  };
  image?: { link: string };
  video?: { link: string };
  document?: { link: string; filename?: string };
  payload?: string;
};

export type MetaTemplateComponent = {
  type: "header" | "body" | "footer" | "button";
  parameters?: MetaTemplateComponentParameter[];
  sub_type?: "quick_reply" | "url";
  index?: string;
};

export type MetaTemplateMessage = {
  name: string;
  language?: {
    code: string;
    policy?: "deterministic" | "fallback";
  } | string;
  components?: MetaTemplateComponent[];
};

export class MetaProvider implements IWhatsAppProvider {
  private token: string;
  private phoneNumberId: string;
  private verifyToken: string;
  private appSecret: string;
  private graphVersion: string;

  constructor(
    token?: string,
    phoneNumberId?: string,
    verifyToken?: string,
    appSecret?: string,
    graphVersion?: string,
  ) {
    this.token = token || process.env.META_TOKEN || "";
    this.phoneNumberId = phoneNumberId || process.env.META_PHONE_NUMBER_ID || "";
    this.verifyToken = verifyToken || process.env.META_VERIFY_TOKEN || "";
    this.appSecret = appSecret || process.env.META_APP_SECRET || "";
    this.graphVersion = graphVersion || process.env.META_GRAPH_VERSION || "v19.0";

    if (!this.token || !this.phoneNumberId) {
      console.warn("Meta credentials not configured. Sending messages will fail.");
    }
  }

  private async postMessage(messagePayload: any): Promise<SendMessageResponse> {
    const response = await fetch(
      `https://graph.facebook.com/${this.graphVersion}/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messagePayload),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Meta API error: ${error}`);
    }

    const data = await response.json();
    return { id: data.messages?.[0]?.id, status: "sent" };
  }

  private applyReplyContext(messagePayload: any, options?: SendMessageOptions) {
    const replyTo = options?.replyToMessageId;
    if (replyTo) {
      messagePayload.context = { message_id: replyTo };
    }
  }

  async send(
    to: string,
    body?: string,
    mediaUrl?: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResponse> {
    if (!this.token || !this.phoneNumberId) {
      throw new Error("Meta credentials not configured. Please set META_TOKEN and META_PHONE_NUMBER_ID environment variables.");
    }

    const cleanPhone = to.replace(/\D/g, "");

    const messagePayload: any = {
      messaging_product: "whatsapp",
      to: cleanPhone,
    };

    this.applyReplyContext(messagePayload, options);

    if (mediaUrl) {
      const normalizedUrl = mediaUrl.split("?")[0].split("#")[0];
      const extension = path.extname(normalizedUrl || "").toLowerCase();

      const asImage = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
      const asVideo = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
      const asAudio = [".mp3", ".mpeg", ".ogg", ".wav", ".aac"];
      const asDocument = [
        ".pdf",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".txt",
        ".csv",
      ];

      const filename = path.basename(normalizedUrl || "attachment");

      if (asImage.includes(extension)) {
        messagePayload.type = "image";
        messagePayload.image = { link: mediaUrl };
        if (body) {
          messagePayload.image.caption = body;
        }
      } else if (asVideo.includes(extension)) {
        messagePayload.type = "video";
        messagePayload.video = { link: mediaUrl };
        if (body) {
          messagePayload.video.caption = body;
        }
      } else if (asAudio.includes(extension)) {
        messagePayload.type = "audio";
        messagePayload.audio = { link: mediaUrl };
      } else if (asDocument.includes(extension) || extension.length === 0) {
        messagePayload.type = "document";
        messagePayload.document = { link: mediaUrl, filename };
        if (body) {
          messagePayload.document.caption = body;
        }
      } else {
        messagePayload.type = "document";
        messagePayload.document = { link: mediaUrl, filename };
        if (body) {
          messagePayload.document.caption = body;
        }
      }
    } else if (body) {
      messagePayload.type = "text";
      messagePayload.text = { body };
    }

    return await this.postMessage(messagePayload);
  }

  async sendTemplate(
    to: string,
    template: MetaTemplateMessage,
    options?: SendMessageOptions,
  ): Promise<SendMessageResponse> {
    if (!this.token || !this.phoneNumberId) {
      throw new Error("Meta credentials not configured. Please set META_TOKEN and META_PHONE_NUMBER_ID environment variables.");
    }

    if (!template?.name) {
      throw new Error("Template name is required.");
    }

    const cleanPhone = to.replace(/\D/g, "");
    const templateLanguage = template.language;
    const language =
      typeof templateLanguage === "string"
        ? { code: templateLanguage.trim() }
        : templateLanguage &&
          typeof templateLanguage === "object" &&
          typeof templateLanguage.code === "string"
        ? { ...templateLanguage, code: templateLanguage.code.trim() }
        : { code: "en_US" };

    const messagePayload = {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "template",
      template: {
        ...template,
        language,
      },
    };

    this.applyReplyContext(messagePayload, options);

    return await this.postMessage(messagePayload);
  }

  verifyWebhook(request: any): boolean {
    const mode = request.query?.["hub.mode"];
    const token = request.query?.["hub.verify_token"];
    return mode === "subscribe" && token === this.verifyToken;
  }

  verifyWebhookSignature(request: any, rawBody: string): boolean {
    const signature = request.headers?.["x-hub-signature-256"];
    if (!signature) {
      console.warn("Missing X-Hub-Signature-256 header");
      return !this.appSecret;
    }

    if (!this.appSecret) {
      return true;
    }

    try {
      const expectedSignature = crypto
        .createHmac("sha256", this.appSecret)
        .update(rawBody)
        .digest("hex");

      const signatureHash = signature.replace("sha256=", "");

      return crypto.timingSafeEqual(
        Buffer.from(signatureHash),
        Buffer.from(expectedSignature)
      );
    } catch (error) {
      console.error("Meta signature verification error:", error);
      return false;
    }
  }

  parseIncoming(payload: any): IncomingMessageEvent[] {
    const events: IncomingMessageEvent[] = [];

    if (!payload?.entry) {
      logger.warn(
        {
          payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
        },
        "meta_webhook_payload_missing_entry",
      );
      return events;
    }

    for (const entry of payload.entry) {
      if (!entry?.changes) {
        logger.debug({ entryId: entry?.id }, "meta_webhook_entry_missing_changes");
        continue;
      }

      for (const change of entry.changes) {
        const messages = change?.value?.messages;
        if (!Array.isArray(messages)) {
          logger.debug({ entryId: entry?.id }, "meta_webhook_change_missing_messages");
          continue;
        }

        for (const msg of messages) {
          const timestampSeconds = Number(msg.timestamp);
          const timestampIso = Number.isFinite(timestampSeconds)
            ? new Date(timestampSeconds * 1000).toISOString()
            : new Date().toISOString();

          const event: IncomingMessageEvent = {
            from: msg.from,
            raw: msg,
            providerMessageId: msg.id,
            replyToProviderMessageId: msg.context?.id,
            timestamp: timestampIso,
          };

          if (msg.type === "text") {
            event.body = msg.text?.body;
          } else if (msg.type === "image") {
            event.media = this.buildMediaDescriptor("image", msg.image);
            event.body = msg.image?.caption ?? msg.caption;
          } else if (msg.type === "document") {
            event.media = this.buildMediaDescriptor("document", msg.document);
            event.body = msg.document?.caption ?? msg.caption;
          } else if (msg.type === "video") {
            event.media = this.buildMediaDescriptor("video", msg.video);
            event.body = msg.video?.caption ?? msg.caption;
          } else if (msg.type === "audio") {
            event.media = this.buildMediaDescriptor("audio", msg.audio);
          } else if (msg.type === "sticker") {
            event.media = this.buildMediaDescriptor("image", msg.sticker);
            event.body = msg.sticker?.emoji ? `Sticker ${msg.sticker.emoji}` : "Sticker";
          } else if (msg.type === "location") {
            const lat = Number(msg.location?.latitude);
            const lng = Number(msg.location?.longitude);
            const lines = [];
            if (msg.location?.name) lines.push(msg.location.name);
            if (msg.location?.address) lines.push(msg.location.address);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
              lines.push(`https://maps.google.com/?q=${lat},${lng}`);
            }
            event.body = lines.length ? lines.join("\n") : "Shared a location";
          } else if (msg.type === "contacts") {
            const contacts = Array.isArray(msg.contacts) ? msg.contacts : [];
            const names = contacts
              .map((contact: any) => contact?.name?.formatted_name || contact?.name?.first_name)
              .filter(Boolean);
            event.body = names.length ? `Contact: ${names.join(", ")}` : "Shared a contact";
          } else if (msg.type === "interactive") {
            const interactive = msg.interactive;
            if (interactive?.type === "button_reply") {
              event.body =
                interactive?.button_reply?.title ?? interactive?.button_reply?.id ?? "Button reply";
            } else if (interactive?.type === "list_reply") {
              event.body =
                interactive?.list_reply?.title ?? interactive?.list_reply?.id ?? "List reply";
            } else if (interactive?.type === "nfm_reply") {
              event.body = interactive?.nfm_reply?.body ?? "Flow reply";
            } else {
              event.body = interactive?.type ? `Interactive: ${interactive.type}` : "Interactive message";
            }
          } else if (msg.type === "button") {
            event.body = msg.button?.text ?? "Button response";
          } else if (msg.type === "reaction") {
            event.body = msg.reaction?.emoji ? `Reaction ${msg.reaction.emoji}` : "Reaction";
          } else if (msg.type === "order") {
            event.body = "Order received";
          } else if (msg.type === "system") {
            event.body = msg.system?.body ?? "System message";
          } else {
            logger.debug({ type: msg.type }, "meta_webhook_unknown_message_type");
          }

          if (!event.body) {
            event.body =
              msg.text?.body ??
              msg.caption ??
              msg.body ??
              msg.title ??
              msg.name ??
              undefined;
          }

          if (!event.body && !event.media && msg.type) {
            event.body = `Unsupported message type: ${msg.type}`;
          }

          events.push(event);
        }
      }
    }

    logger.debug({ eventCount: events.length }, "meta_webhook_events_parsed");
    return events;
  }

  getAccessToken(): string {
    return this.token;
  }

  getGraphVersion(): string {
    return this.graphVersion;
  }

  async fetchMediaMetadata(mediaId: string): Promise<MetaMediaMetadata> {
    if (!this.token) {
      throw new Error("Meta access token is not configured");
    }

    const response = await fetch(
      `https://graph.facebook.com/${this.graphVersion}/${mediaId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to fetch media metadata (${response.status}): ${body}`);
    }

    return (await response.json()) as MetaMediaMetadata;
  }

  async downloadMedia(url: string): Promise<{ buffer: Buffer; contentType?: string | null }> {
    if (!this.token) {
      throw new Error("Meta access token is not configured");
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to download media (${response.status}): ${body}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type");
    return { buffer: Buffer.from(arrayBuffer), contentType };
  }

  private buildMediaDescriptor(type: IncomingMediaType, payload: any): IncomingMediaDescriptor | undefined {
    if (!payload) return undefined;

    const descriptor: IncomingMediaDescriptor = {
      provider: "meta",
      type,
      mediaId: payload?.id ?? payload?.media_id ?? undefined,
      url: payload?.link ?? undefined,
      mimeType: payload?.mime_type ?? payload?.mimetype ?? undefined,
      filename: payload?.filename ?? undefined,
      sha256: payload?.sha256 ?? undefined,
      sizeBytes: payload?.file_size ?? payload?.filesize ?? undefined,
      width: payload?.width ?? undefined,
      height: payload?.height ?? undefined,
      durationSeconds: payload?.duration ?? undefined,
      pageCount: payload?.page_count ?? undefined,
      previewUrl: payload?.preview_url ?? undefined,
      thumbnailUrl: payload?.thumbnail_url ?? undefined,
      metadata: payload,
    };

    return descriptor;
  }
}

export interface MetaMediaMetadata {
  id: string;
  url: string;
  mime_type?: string;
  sha256?: string;
  file_size?: number;
  width?: number;
  height?: number;
  voice?: boolean;
  messaging_product?: string;
  name?: string;
}
