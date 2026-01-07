import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const STORAGE_KEY = 'chat_unread_counts';

interface UnreadCountsState {
  [conversationId: string]: number;
}

export function useUnreadCounts(selectedConversationId: string | null) {
  const queryClient = useQueryClient();

  const [counts, setCounts] = useState<UnreadCountsState>(() => {
    if (typeof window === 'undefined') return {};
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    try {
      return JSON.parse(stored) as UnreadCountsState;
    } catch {
      return {};
    }
  });

  // Increment unread count for a conversation
  const incrementUnread = useCallback((conversationId: string) => {
    if (conversationId === selectedConversationId) return; // Don't increment for active chat

    setCounts((prev) => {
      const next = {
        ...prev,
        [conversationId]: (prev[conversationId] || 0) + 1,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });

    // Invalidate conversations query to trigger UI update
    queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
  }, [selectedConversationId, queryClient]);

  // Reset unread count for a conversation
  const resetUnread = useCallback((conversationId: string) => {
    setCounts((prev) => {
      if (!prev[conversationId]) return prev;
      const next = { ...prev };
      delete next[conversationId];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
  }, [queryClient]);

  // Reset count when conversation becomes active
  useEffect(() => {
    if (selectedConversationId) {
      resetUnread(selectedConversationId);
    }
  }, [selectedConversationId, resetUnread]);

  return {
    counts,
    incrementUnread,
    resetUnread
  };
}
