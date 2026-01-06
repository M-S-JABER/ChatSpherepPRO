import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";

interface NewConversationDialogProps {
  onCreateConversation: (payload: { phone: string; body?: string }) => void;
  triggerClassName?: string;
  showLabel?: boolean;
}

export function NewConversationDialog({
  onCreateConversation,
  triggerClassName,
  showLabel = true,
}: NewConversationDialogProps) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("964");
  const [message, setMessage] = useState("");
  const isValidPhone = /^\d{13,15}$/.test(phone.trim());

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = phone.trim();
    if (!trimmed) return;
    if (!isValidPhone) {
      setPhone("964");
      return;
    }

    const trimmedMessage = message.trim();

    onCreateConversation({
      phone: trimmed,
      body: trimmedMessage.length > 0 ? trimmedMessage : undefined,
    });
    setPhone("964");
    setMessage("");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="default"
          className={cn("h-9 gap-2 rounded-full px-4", triggerClassName)}
          data-testid="button-new-conversation"
        >
          <MessageSquarePlus className="h-4 w-4" />
          {showLabel && <span>New chat</span>}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" data-testid="dialog-new-conversation">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New Conversation</DialogTitle>
            <DialogDescription>
              Enter a phone number to start a new WhatsApp conversation. A template message will be sent to begin the chat.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="phone">Phone Number</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="9647xxxxxxxxx"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                className="font-mono"
                data-testid="input-phone-number"
              />
              <p className="text-xs text-muted-foreground">
                Country code is required. Default is 964. Minimum 10 digits after the 964 sign.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="message">Message (optional)</Label>
              <Textarea
                id="message"
                placeholder="Optional template parameter"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                data-testid="input-initial-message"
              />
              <p className="text-xs text-muted-foreground">
                If provided, this will be used as the first template parameter.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen(false);
                setPhone("964");
              }}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!isValidPhone} data-testid="button-start-chat">
              Start Chat
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
