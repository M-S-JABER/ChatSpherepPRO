import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";

const ACTIVITY_PING_INTERVAL_MS = 60 * 1000;

export const useActivityPing = () => {
  const { user } = useAuth();
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !user) {
      return;
    }

    let isActive = true;

    const sendPing = () => {
      if (!isActive || document.visibilityState !== "visible") {
        return;
      }

      fetch("/api/activity/ping", {
        method: "POST",
        credentials: "include",
      }).catch(() => {});
    };

    sendPing();
    timerRef.current = window.setInterval(sendPing, ACTIVITY_PING_INTERVAL_MS);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        sendPing();
      }
    };

    window.addEventListener("focus", sendPing);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      isActive = false;
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
      }
      window.removeEventListener("focus", sendPing);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [user?.id]);
};
