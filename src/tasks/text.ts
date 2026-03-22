import { getCurrentLocale } from "../i18n";
import type { TaskApprovalRequest, TaskDecisionOption, TaskMode, TaskState } from "./types";

function isEnglish(): boolean {
  return getCurrentLocale() === "en";
}

export function providerStatusDisabled(): { label: string; message: string; detail: string } {
  if (isEnglish()) {
    return {
      label: "Disabled",
      message: "Provider status: disabled.",
      detail: "Set clawdrive.provider.enabled to true to enable Codex task execution.",
    };
  }

  return {
    label: "\u672A\u542F\u7528",
    message: "Provider \u72B6\u6001\uff1a\u672A\u542F\u7528\u3002",
    detail: "\u5C06 clawdrive.provider.enabled \u8BBE\u4E3A true \u540E\u624D\u80FD\u542F\u7528 Codex \u4EFB\u52A1\u6267\u884C\u3002",
  };
}

export function providerStatusReady(kindLabel: string): { label: string; message: string; detail: string } {
  if (isEnglish()) {
    return {
      label: `Ready (${kindLabel})`,
      message: "Provider status: ready.",
      detail: `${kindLabel} is enabled and runnable.`,
    };
  }

  return {
    label: `\u5C31\u7EEA\uff08${kindLabel}\uff09`,
    message: "Provider \u72B6\u6001\uff1a\u5C31\u7EEA\u3002",
    detail: `${kindLabel} \u5DF2\u542F\u7528\u4E14\u53EF\u8FD0\u884C\u3002`,
  };
}

export function providerStatusMissing(detail: string): { label: string; message: string; detail: string } {
  if (isEnglish()) {
    return {
      label: "Unavailable (path problem)",
      message: "Provider status: executable not found.",
      detail,
    };
  }

  return {
    label: "\u4E0D\u53EF\u7528\uff08\u8DEF\u5F84\u95EE\u9898\uff09",
    message: "Provider \u72B6\u6001\uff1a\u627E\u4E0D\u5230\u53EF\u6267\u884C\u6587\u4EF6\u3002",
    detail,
  };
}

export function providerStatusError(detail: string): { label: string; message: string; detail: string } {
  if (isEnglish()) {
    return {
      label: "Unavailable (probe failed)",
      message: "Provider status: probe failed.",
      detail,
    };
  }

  return {
    label: "\u4E0D\u53EF\u7528\uff08\u63A2\u6D4B\u5931\u8D25\uff09",
    message: "Provider \u72B6\u6001\uff1A\u63A2\u6D4B\u5931\u8D25\u3002",
    detail,
  };
}

export function taskModeLabel(mode: TaskMode): string {
  if (isEnglish()) {
    if (mode === "plan") {
      return "Plan";
    }
    if (mode === "apply") {
      return "Apply";
    }
    return "Analyze";
  }
  if (mode === "plan") {
    return "\u89C4\u5212";
  }
  if (mode === "apply") {
    return "\u6267\u884C\u4fee\u6539";
  }
  return "\u5206\u6790";
}

export function taskStateLabel(state: TaskState): string {
  const zh: Record<TaskState, string> = {
    queued: "\u6392\u961F\u4E2D",
    running: "\u8FD0\u884C\u4E2D",
    waiting_decision: "\u7B49\u5F85\u51B3\u7B56",
    waiting_approval: "\u7B49\u5F85\u6279\u51C6",
    completed: "\u5DF2\u5B8C\u6210",
    failed: "\u5DF2\u5931\u8D25",
    cancelled: "\u5DF2\u53D6\u6D88",
    interrupted: "\u5DF2\u4E2D\u65AD",
  };
  const en: Record<TaskState, string> = {
    queued: "Queued",
    running: "Running",
    waiting_decision: "Waiting",
    waiting_approval: "Awaiting Approval",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
  };
  return isEnglish() ? en[state] : zh[state];
}

export function taskQueuedSummary(mode: TaskMode): string {
  return isEnglish()
    ? `${taskModeLabel(mode)} task queued.`
    : `${taskModeLabel(mode)}\u4EFB\u52A1\u5DF2\u8FDB\u5165\u961F\u5217\u3002`;
}

export function taskStartedSummary(mode: TaskMode): string {
  return isEnglish()
    ? `${taskModeLabel(mode)} task is running.`
    : `${taskModeLabel(mode)}\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C\u3002`;
}

export function taskWaitingSummary(optionCount: number): string {
  return isEnglish()
    ? `Waiting for a decision across ${optionCount} option(s).`
    : `\u6B63\u5728\u7B49\u5F85\u4F60\u4ECE ${optionCount} \u4E2A\u9009\u9879\u4E2D\u505A\u51FA\u51B3\u5B9A\u3002`;
}

export function taskWaitingApprovalSummary(operationCount: number): string {
  return isEnglish()
    ? `Waiting for approval to apply ${operationCount} operation(s).`
    : `\u6B63\u5728\u7B49\u5F85\u4F60\u6279\u51C6 ${operationCount} \u4E2A\u4FEE\u6539\u64CD\u4F5C\u3002`;
}

export function taskCompletedSummary(): string {
  return isEnglish() ? "Task completed." : "\u4EFB\u52A1\u5DF2\u5B8C\u6210\u3002";
}

export function taskInterruptedSummary(): string {
  return isEnglish()
    ? "Task was interrupted and can be resumed."
    : "\u4EFB\u52A1\u5DF2\u4E2D\u65AD\uff0C\u53EF\u4EE5\u7EE7\u7EED\u3002";
}

export function taskCancelledSummary(): string {
  return isEnglish() ? "Task cancelled." : "\u4EFB\u52A1\u5DF2\u53D6\u6D88\u3002";
}

export function taskRejectedSummary(): string {
  return isEnglish() ? "Apply request rejected." : "\u4F60\u5DF2\u62D2\u7EDD\u6B64\u6B21\u4FEE\u6539\u6267\u884C\u3002";
}

export function taskFailedSummary(message: string): string {
  return isEnglish() ? `Task failed: ${message}` : `\u4EFB\u52A1\u5931\u8D25\uff1A${message}`;
}

export function taskResumePrompt(option?: TaskDecisionOption, message?: string): string {
  if (option) {
    return isEnglish()
      ? `Continue with option ${option.id}: ${option.title}. Do not modify files. Produce a detailed implementation-ready plan only.`
      : `\u8BF7\u57FA\u4E8E\u9009\u9879 ${option.id}\uFF1A${option.title} \u7EE7\u7EED\u3002\u4E0D\u8981\u4FEE\u6539\u6587\u4EF6\uff0C\u53EA\u8F93\u51FA\u53EF\u6267\u884C\u7684\u8BE6\u7EC6\u8BA1\u5212\u3002`;
  }
  if (message?.trim()) {
    return message.trim();
  }
  return isEnglish()
    ? "Continue the previous task without modifying files and provide the next useful result."
    : "\u8BF7\u7EE7\u7EED\u4E0A\u4E00\u8F6E\u4EFB\u52A1\uff0C\u4E0D\u8981\u4FEE\u6539\u6587\u4EF6\uff0C\u76F4\u63A5\u7ED9\u51FA\u4E0B\u4E00\u4E2A\u6709\u7528\u7ED3\u679C\u3002";
}

export function taskWriteBlockedMessage(): string {
  return isEnglish()
    ? "This request needs apply mode or an explicit planning-first prompt."
    : "\u8FD9\u7C7B\u8BF7\u6C42\u9700\u8981\u8FDB\u5165 apply \u6A21\u5F0F\uff0C\u6216\u8005\u5148\u660E\u786E\u8981\u6C42\u53EA\u51FA\u89C4\u5212\u65B9\u6848\u3002";
}

export function taskApprovalTitle(): string {
  return isEnglish() ? "Approval:" : "\u5F85\u6279\u51C6\u4FEE\u6539\uff1A";
}

export function taskApprovalSummary(approval: TaskApprovalRequest): string {
  return isEnglish()
    ? `${approval.summary} (${approval.operations.length} operation(s))`
    : `${approval.summary}\uFF08${approval.operations.length} \u4E2A\u64CD\u4F5C\uFF09`;
}

export function taskResultTitle(title: string, state: TaskState): string {
  return isEnglish()
    ? `${title} (${taskStateLabel(state)})`
    : `${title}\uFF08${taskStateLabel(state)}\uFF09`;
}
