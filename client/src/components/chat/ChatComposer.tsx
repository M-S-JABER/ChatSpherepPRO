import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Attachment, AttachmentBar, type AttachmentUploadState } from "./AttachmentBar";
import {
  DEFAULT_ACCEPTED_TYPES,
  validateFiles,
  readDroppedText,
  isImage,
} from "@/lib/attachmentUtils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import EmojiPicker, { EmojiClickData } from "emoji-picker-react";
import { FileText, Paperclip, Send, Smile, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { type TemplateCatalogItem } from "@/types/templates";
import { type ReadyMessage } from "@shared/schema";

type ComposerAttachment = Attachment;
type UpdateAttachmentUploadState = (id: string, state: Partial<AttachmentUploadState>) => void;

export type ChatComposerSendPayload = {
  text: string;
  attachments: ComposerAttachment[];
  replyToMessageId?: string;
  setAttachmentUploadState: UpdateAttachmentUploadState;
};

export type ChatComposerTemplateSendPayload = {
  template: TemplateCatalogItem;
  params: string[];
  replyToMessageId?: string;
};

type ReplyContext = {
  id: string;
  senderLabel: string;
  snippet: string;
};

export type ChatComposerProps = {
  onSend: (payload: ChatComposerSendPayload) => Promise<void> | void;
  onSendTemplate?: (payload: ChatComposerTemplateSendPayload) => Promise<void> | void;
  templates?: TemplateCatalogItem[];
  readyMessages?: ReadyMessage[];
  maxFiles?: number;
  maxFileSizeMB?: number;
  acceptedTypes?: ReadonlyArray<string>;
  disabled?: boolean;
  className?: string;
  replyTo?: ReplyContext | null;
  onClearReply?: () => void;
};

export interface ChatComposerHandle {
  attachments: ComposerAttachment[];
  addAttachments: (files: File[]) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  insertText: (text: string) => void;
  setAttachmentUploadState: UpdateAttachmentUploadState;
}

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_FILE_SIZE_MB = 100;

const createAttachment = (file: File): ComposerAttachment => {
  const mime = file.type || "application/octet-stream";
  const kind: ComposerAttachment["kind"] = isImage(mime) ? "image" : "file";
  const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
  return {
    id: crypto.randomUUID(),
    file,
    kind,
    name: file.name || "Untitled",
    mime,
    size: file.size,
    previewUrl,
    uploadState: {
      status: "pending",
      progress: 0,
    },
  };
};

const revokeAttachmentUrl = (attachment: ComposerAttachment) => {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
};

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(
  function ChatComposer(
    {
      onSend,
      onSendTemplate,
      templates = [],
      readyMessages = [],
      maxFiles = DEFAULT_MAX_FILES,
      maxFileSizeMB = DEFAULT_MAX_FILE_SIZE_MB,
      acceptedTypes = DEFAULT_ACCEPTED_TYPES,
      disabled,
      className,
      replyTo,
      onClearReply,
    },
    ref,
  ) {
    const [message, setMessage] = useState("");
    const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
    const [errors, setErrors] = useState<string[]>([]);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [templatePanelOpen, setTemplatePanelOpen] = useState(false);
    const [selectedTemplateName, setSelectedTemplateName] = useState<string | null>(null);
    const [templateParamsInput, setTemplateParamsInput] = useState("");
    const [selectedReadyMessageId, setSelectedReadyMessageId] = useState<string | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
    const attachmentsRef = useRef<ComposerAttachment[]>(attachments);
    const clearTimerRef = useRef<number | null>(null);
    const templateAutoOpenRef = useRef(false);

    const updateSelection = useCallback(() => {
      const el = textareaRef.current;
      if (!el) return;
      selectionRef.current = {
        start: el.selectionStart ?? el.value.length,
        end: el.selectionEnd ?? el.value.length,
      };
    }, []);

    const insertTextAtCursor = useCallback((text: string) => {
      if (!text) return;
      const { start, end } = selectionRef.current;
      setMessage((prev) => {
        const before = prev.slice(0, start);
        const after = prev.slice(end);
        const next = `${before}${text}${after}`;

        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          const cursor = before.length + text.length;
          el.focus();
          el.setSelectionRange(cursor, cursor);
          selectionRef.current = { start: cursor, end: cursor };
        });

        return next;
      });
    }, []);

    const appendErrors = useCallback((rejections: Array<{ file: File; reason: string }>) => {
      if (rejections.length === 0) return;
      setErrors((prev) => {
        const messages = rejections.map((item) => `${item.file.name}: ${item.reason}`);
        const next = [...prev, ...messages];
        return Array.from(new Set(next));
      });
    }, []);

    const addAttachments = useCallback(
      (files: File[]) => {
        if (!files || files.length === 0) return;

        const { accepted, rejected } = validateFiles(files, {
          maxFiles,
          maxFileSizeMB,
          acceptedTypes,
          currentCount: attachments.length,
        });

        appendErrors(rejected);

        if (accepted.length === 0) {
          return;
        }

        setAttachments((prev) => [...prev, ...accepted.map(createAttachment)]);
      },
      [acceptedTypes, appendErrors, attachments.length, maxFileSizeMB, maxFiles],
    );

    const removeAttachment = useCallback((id: string) => {
      setAttachments((prev) => {
        const next = prev.filter((item) => {
          if (item.id === id) {
            revokeAttachmentUrl(item);
            return false;
          }
          return true;
        });
        return next;
      });
    }, []);

    const clearAttachments = useCallback(() => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }

      setAttachments((prev) => {
        prev.forEach(revokeAttachmentUrl);
        return [];
      });
    }, []);

    const setAttachmentUploadState = useCallback<UpdateAttachmentUploadState>((id, state) => {
      setAttachments((prev) =>
        prev.map((item) => {
          if (item.id !== id) {
            return item;
          }

          const previousState = item.uploadState ?? { status: "pending", progress: 0 };
          const nextStatus = state.status ?? previousState.status;
          let nextProgress =
            state.progress !== undefined ? Math.max(0, Math.min(100, state.progress)) : previousState.progress;

          if (nextStatus === "success" && state.progress === undefined) {
            nextProgress = 100;
          }

          const nextError =
            state.error ??
            (nextStatus === "error" ? previousState.error ?? "Upload failed." : undefined);

          return {
            ...item,
            uploadState: {
              status: nextStatus,
              progress: nextProgress,
              error: nextError,
            },
          };
        }),
      );
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        attachments,
        addAttachments,
        removeAttachment,
        clearAttachments,
        insertText: insertTextAtCursor,
        setAttachmentUploadState,
      }),
      [attachments, addAttachments, clearAttachments, insertTextAtCursor, removeAttachment, setAttachmentUploadState],
    );

    useEffect(() => {
      attachmentsRef.current = attachments;
    }, [attachments]);

    const availableTemplates = useMemo(
      () =>
        templates
          .map((template) => ({
            ...template,
            name: typeof template.name === "string" ? template.name.trim() : "",
          }))
          .filter((template) => template.name.length > 0),
      [templates],
    );

    const availableReadyMessages = useMemo(
      () =>
        readyMessages
          .map((message) => ({
            ...message,
            name: typeof message.name === "string" ? message.name.trim() : "",
            body: typeof message.body === "string" ? message.body : "",
          }))
          .filter((message) => message.name.length > 0 && message.body.trim().length > 0),
      [readyMessages],
    );

    useEffect(() => {
      if (availableTemplates.length === 0) {
        if (selectedTemplateName !== null) {
          setSelectedTemplateName(null);
        }
        return;
      }

      const exists = availableTemplates.some((template) => template.name === selectedTemplateName);
      if (!exists) {
        setSelectedTemplateName(availableTemplates[0].name);
      }
    }, [availableTemplates, selectedTemplateName]);

    useEffect(() => {
      if (availableReadyMessages.length === 0) {
        if (selectedReadyMessageId !== null) {
          setSelectedReadyMessageId(null);
        }
        return;
      }

      const exists = availableReadyMessages.some(
        (message) => message.id === selectedReadyMessageId,
      );
      if (!exists) {
        setSelectedReadyMessageId(availableReadyMessages[0].id);
      }
    }, [availableReadyMessages, selectedReadyMessageId]);

    useEffect(() => {
      if (templateAutoOpenRef.current) return;
      if (availableTemplates.length > 0 || availableReadyMessages.length > 0) {
        setTemplatePanelOpen(true);
        templateAutoOpenRef.current = true;
      }
    }, [availableTemplates.length, availableReadyMessages.length]);

    useEffect(() => {
      return () => {
        attachmentsRef.current.forEach(revokeAttachmentUrl);
        if (clearTimerRef.current !== null) {
          window.clearTimeout(clearTimerRef.current);
        }
      };
    }, []);

    // إبقاء الـ textarea بالحجم المناسب عند تغيّر النص (تعزيز للأوتو-ريسايز في onChange)
    useEffect(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      }
    }, [message]);

    const parseTemplateParamsInput = useCallback((input: string): string[] => {
      const trimmed = input.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return parsed.map((item) => String(item)).filter((item) => item.trim().length > 0);
          }
        } catch {
          return [trimmed];
        }
      }
      return [trimmed];
    }, []);

    const selectedTemplate =
      availableTemplates.find((template) => template.name === selectedTemplateName) ??
      availableTemplates[0] ??
      null;

    const selectedReadyMessage =
      availableReadyMessages.find((message) => message.id === selectedReadyMessageId) ??
      availableReadyMessages[0] ??
      null;

    const templateParams = parseTemplateParamsInput(templateParamsInput);
    const expectedParamCount = selectedTemplate?.bodyParams ?? 0;
    const hasRequiredParams =
      expectedParamCount === 0 || templateParams.length >= expectedParamCount;
    const canSendTemplate =
      Boolean(onSendTemplate && selectedTemplate) &&
      !disabled &&
      !isSending &&
      attachments.length === 0 &&
      hasRequiredParams;
    const canSendReadyMessage =
      Boolean(selectedReadyMessage) &&
      !disabled &&
      !isSending &&
      attachments.length === 0;

    const handleEmojiClick = (emojiData: EmojiClickData) => {
      insertTextAtCursor(emojiData.emoji);
      setShowEmojiPicker(false);
    };

    const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      addAttachments(files);
      event.target.value = "";
    };

    const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const clipboard = event.clipboardData;
      if (!clipboard) return;

      const files = Array.from(clipboard.files ?? []);
      const text = clipboard.getData("text");

      if (files.length > 0) {
        event.preventDefault();
        addAttachments(files);
        if (text) {
          insertTextAtCursor(text);
        }
        return;
      }
      requestAnimationFrame(updateSelection);
    };

    const handleDrop = async (event: React.DragEvent<HTMLTextAreaElement | HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();

      const dataTransfer = event.dataTransfer;
      const files = Array.from(dataTransfer?.files ?? []);
      if (files.length > 0) {
        addAttachments(files);
      }
      const text = await readDroppedText(dataTransfer);
      if (text) {
        insertTextAtCursor(text);
      }
    };

    const handleTemplateSend = async () => {
      if (!onSendTemplate || !selectedTemplate || disabled || isSending) {
        return;
      }

      if (attachments.length > 0) {
        setErrors((prev) =>
          Array.from(new Set([...prev, "Remove attachments before sending a template."]))
        );
        return;
      }

      if (!hasRequiredParams) {
        setErrors((prev) =>
          Array.from(
            new Set([
              ...prev,
              `Provide at least ${expectedParamCount} parameter${expectedParamCount === 1 ? "" : "s"} for this template.`,
            ]),
          ),
        );
        return;
      }

      setErrors([]);
      setIsSending(true);
      try {
        await onSendTemplate({
          template: selectedTemplate,
          params: templateParams,
          replyToMessageId: replyTo?.id,
        });
        onClearReply?.();
      } finally {
        setIsSending(false);
      }
    };

    const handleReadyMessageSend = async () => {
      if (!selectedReadyMessage || disabled || isSending) {
        return;
      }

      if (attachments.length > 0) {
        setErrors((prev) =>
          Array.from(new Set([...prev, "Remove attachments before sending a ready message."])),
        );
        return;
      }

      setErrors([]);
      setIsSending(true);
      try {
        await onSend({
          text: selectedReadyMessage.body,
          attachments: [],
          replyToMessageId: replyTo?.id,
          setAttachmentUploadState,
        });
        onClearReply?.();
      } finally {
        setIsSending(false);
      }
    };

    const handleSend = async () => {
      const trimmed = message.trim();
      if ((trimmed.length === 0 && attachments.length === 0) || disabled || isSending) {
        return;
      }

      setErrors([]);
      setIsSending(true);
      try {
        await onSend({
          text: trimmed,
          attachments,
          replyToMessageId: replyTo?.id,
          setAttachmentUploadState,
        });
        setMessage("");
        onClearReply?.();

        const snapshot = attachmentsRef.current;
        const shouldClear =
          snapshot.length === 0 ||
          snapshot.every((item) => item.uploadState?.status === "success");

        if (shouldClear) {
          const delay = snapshot.length > 0 ? 600 : 0;
          if (clearTimerRef.current !== null) {
            window.clearTimeout(clearTimerRef.current);
          }
          clearTimerRef.current = window.setTimeout(() => {
            clearAttachments();
            clearTimerRef.current = null;
          }, delay);
        }
      } finally {
        setIsSending(false);
      }
    };

    const isSendDisabled =
      disabled ||
      isSending ||
      (message.trim().length === 0 && attachments.length === 0);
    const canToggleTemplatePanel =
      Boolean(onSendTemplate) || availableReadyMessages.length > 0;

    return (
      <div
        className={cn(
          // ✅ الحاوية الخارجية للـ composer تبقى أسفل إطار المحادثة نفسه
          "sticky bottom-0 inset-x-0 z-10",
          // خلفية شبه زجاجية وحد علوي وظل خفيف ليفصلها بصرياً
          "bg-background/95 backdrop-blur-md border-t border-border/60 shadow-[0_-6px_16px_rgba(0,0,0,0.08)]",
          // مسافات مريحة + دعم السيف-إريا على الموبايل
          "px-3 py-2 md:px-6",
          className
        )}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        onDrop={handleDrop}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
        }}
      >
        {replyTo && (
          <div
            className="mb-2 flex items-start justify-between rounded-lg border border-primary/40 bg-primary/10 px-3 py-2"
            aria-live="polite"
          >
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                Replying to {replyTo.senderLabel}
              </p>
              <p className="text-sm text-foreground/90 line-clamp-2">
                {replyTo.snippet}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-2 text-primary"
              onClick={onClearReply}
              aria-label={`Clear reply to: ${replyTo.snippet}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        <AttachmentBar attachments={attachments} onRemove={removeAttachment} />

        {errors.length > 0 && (
          <div className="mt-1 text-sm text-destructive" role="status" aria-live="polite">
            {errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        )}

        {templatePanelOpen && (
          <div className="mt-2 rounded-2xl border border-border/60 bg-card/95 px-3 py-3 shadow-sm">
            {availableTemplates.length === 0 && availableReadyMessages.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No templates or ready messages configured. Set META_TEMPLATE_CATALOG or add ready messages in Settings.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {availableTemplates.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <div className="grid gap-3 md:grid-cols-[1.2fr_1.6fr_auto] md:items-end">
                      <div className="space-y-1">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Template
                        </p>
                        <Select
                          value={selectedTemplate?.name ?? ""}
                          onValueChange={(value) => setSelectedTemplateName(value)}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder="Choose template" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableTemplates.map((template) => (
                              <SelectItem key={template.name} value={template.name}>
                                {template.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {selectedTemplate?.language && (
                          <p className="text-[11px] text-muted-foreground">
                            Language: {selectedTemplate.language}
                          </p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Parameters
                        </p>
                        <Input
                          value={templateParamsInput}
                          onChange={(event) => setTemplateParamsInput(event.target.value)}
                          placeholder='["name","order"] or single value'
                          className="h-9"
                          disabled={!selectedTemplate || disabled}
                        />
                        <p className="text-[11px] text-muted-foreground">
                          {selectedTemplate?.bodyParams
                            ? `Expected ${selectedTemplate.bodyParams} parameter${
                                selectedTemplate.bodyParams === 1 ? "" : "s"
                              }. Use JSON array for multiple values.`
                            : "Use JSON array for multiple values."}
                        </p>
                        {expectedParamCount > 0 && templateParams.length < expectedParamCount && (
                          <p className="text-[11px] text-destructive">
                            Missing {expectedParamCount - templateParams.length} parameter
                            {expectedParamCount - templateParams.length === 1 ? "" : "s"}.
                          </p>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-9 w-full md:w-auto"
                        onClick={handleTemplateSend}
                        disabled={!canSendTemplate}
                      >
                        Send template
                      </Button>
                    </div>
                    {attachments.length > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        Remove attachments before sending a template.
                      </p>
                    )}
                    {selectedTemplate?.description && (
                      <p className="text-xs text-muted-foreground">{selectedTemplate.description}</p>
                    )}
                  </div>
                )}

                {availableReadyMessages.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <div className="grid gap-3 md:grid-cols-[1.2fr_1.6fr_auto] md:items-end">
                      <div className="space-y-1">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Ready message
                        </p>
                        <Select
                          value={selectedReadyMessage?.id ?? ""}
                          onValueChange={(value) => setSelectedReadyMessageId(value)}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder="Choose message" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableReadyMessages.map((message) => (
                              <SelectItem key={message.id} value={message.id}>
                                {message.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Preview
                        </p>
                        <div className="rounded-md border border-border/60 bg-background/60 px-3 py-2 text-xs text-muted-foreground line-clamp-3">
                          {selectedReadyMessage?.body ?? "No message selected."}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-9 w-full md:w-auto"
                        onClick={handleReadyMessageSend}
                        disabled={!canSendReadyMessage}
                      >
                        Send ready message
                      </Button>
                    </div>
                    {attachments.length > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        Remove attachments before sending a ready message.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ✅ كتلة الـ composer نفسها */}
        <div className="mt-2 flex items-end gap-2 rounded-2xl border border-border/60 bg-card/95 px-2 py-2 shadow-sm">
          <Popover open={showEmojiPicker} onOpenChange={setShowEmojiPicker}>
            <PopoverTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                type="button"
                className="h-9 w-9 rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                disabled={disabled}
                aria-label="Insert emoji"
              >
                <Smile className="h-5 w-5" />
              </Button>
            </PopoverTrigger>
            {/* ✅ رفع الـ z-index للـ popover عشان ما يختفي وراء الـ composer */}
            <PopoverContent side="top" align="start" className="z-50 w-auto border-none p-0 shadow-lg">
              <EmojiPicker
                onEmojiClick={handleEmojiClick}
                searchDisabled={false}
                skinTonesDisabled
                width={320}
                height={380}
                lazyLoadEmojis
              />
            </PopoverContent>
          </Popover>

          <Button
            size="icon"
            variant={templatePanelOpen ? "secondary" : "ghost"}
            type="button"
            className="h-9 w-9 rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={() => setTemplatePanelOpen((prev) => !prev)}
            disabled={!canToggleTemplatePanel}
            aria-label="Toggle templates"
          >
            <FileText className="h-5 w-5" />
          </Button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
            accept={acceptedTypes.join(",")}
          />

          <Button
            size="icon"
            variant="ghost"
            type="button"
            className="h-9 w-9 rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || attachments.length >= maxFiles}
            aria-label="Attach files"
          >
            <Paperclip className="h-5 w-5" />
          </Button>

          <div className="relative flex flex-1 items-center px-1">
            <Textarea
              ref={textareaRef}
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
                requestAnimationFrame(updateSelection);
                // ✅ أوتو-ريسايز نظيف
                const textarea = event.target;
                textarea.style.height = "auto";
                const next = Math.min(textarea.scrollHeight, 160);
                textarea.style.height = `${next}px`;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              onSelect={updateSelection}
              onKeyUp={updateSelection}
              onClick={updateSelection}
              onPaste={handlePaste}
              onDrop={handleDrop}
              placeholder="Type a message"
              disabled={disabled}
              rows={1}
              // ✅ أصلحنا حجم النص (كان text-[5px]) وخلّيناه مقروء
              className="w-full resize-none border-none bg-transparent text-sm leading-6 placeholder:text-muted-foreground focus-visible:ring-0"
              style={{
                minHeight: "44px",
                maxHeight: "160px",
                overflow: "hidden",
              }}
            />
          </div>

          <Button
            size="icon"
            variant="default"
            type="button"
            onClick={handleSend}
            disabled={isSendDisabled}
            className={cn(
              "h-10 w-10 rounded-full shadow-sm transition-all active:scale-95",
              isSendDisabled && "pointer-events-none opacity-60",
            )}
            aria-label="Send message"
          >
            <Send className="h-5 w-5" />
          </Button>
        </div>

        {attachments.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
            {attachments.length} attachment{attachments.length === 1 ? "" : "s"} ready to send.
          </p>
        )}
      </div>
    );
  },
);

ChatComposer.displayName = "ChatComposer";
