import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import {
  handleGmailHistoryChanged,
  renewGmailWatches,
  reconcilePendingDrafts,
  reconcileUsageReporting,
} from "@/lib/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    handleGmailHistoryChanged,
    renewGmailWatches,
    reconcilePendingDrafts,
    reconcileUsageReporting,
  ],
});