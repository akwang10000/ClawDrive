import * as vscode from "vscode";

const CLAUDE_VSCODE_EXTENSION_IDS = ["anthropic.claude-code", "Anthropic.claude-code"] as const;

export interface ClaudeVsCodeHandoffRequest {
  prompt: string;
  sessionId?: string;
}

export type ClaudeVsCodeHandoffResult =
  | {
      ok: true;
      target: "claude-vscode";
      extensionId: string;
      prompt: string;
      uri: string;
      autoSubmitted: false;
      sessionId?: string;
    }
  | {
      ok: false;
      target: "claude-vscode";
      code: "CLAUDE_VSCODE_NOT_INSTALLED" | "CLAUDE_VSCODE_OPEN_FAILED";
      message: string;
      prompt: string;
      uri?: string;
      autoSubmitted: false;
      sessionId?: string;
    };

export interface ClaudeVsCodeHandoff {
  openPrompt(input: ClaudeVsCodeHandoffRequest): Promise<ClaudeVsCodeHandoffResult>;
}

export class ClaudeVsCodeUriHandoff implements ClaudeVsCodeHandoff {
  async openPrompt(input: ClaudeVsCodeHandoffRequest): Promise<ClaudeVsCodeHandoffResult> {
    const prompt = input.prompt.trim();
    const sessionId = input.sessionId?.trim() || undefined;
    if (!prompt) {
      return {
        ok: false,
        target: "claude-vscode",
        code: "CLAUDE_VSCODE_OPEN_FAILED",
        message: "A non-empty prompt is required before opening Claude Code for VS Code.",
        prompt,
        autoSubmitted: false,
        sessionId,
      };
    }

    const extensionId = findClaudeVsCodeExtensionId();
    const uri = buildClaudeVsCodeUri(prompt, sessionId);

    if (!extensionId) {
      return {
        ok: false,
        target: "claude-vscode",
        code: "CLAUDE_VSCODE_NOT_INSTALLED",
        message: "Claude Code for VS Code is not installed. Install the Anthropic Claude Code extension first.",
        prompt,
        uri: uri.toString(),
        autoSubmitted: false,
        sessionId,
      };
    }

    const opened = await vscode.env.openExternal(uri);
    if (!opened) {
      return {
        ok: false,
        target: "claude-vscode",
        code: "CLAUDE_VSCODE_OPEN_FAILED",
        message: "Claude Code for VS Code did not accept the handoff request.",
        prompt,
        uri: uri.toString(),
        autoSubmitted: false,
        sessionId,
      };
    }

    return {
      ok: true,
      target: "claude-vscode",
      extensionId,
      prompt,
      uri: uri.toString(),
      autoSubmitted: false,
      sessionId,
    };
  }
}

export function findClaudeVsCodeExtensionId(): string | null {
  for (const extensionId of CLAUDE_VSCODE_EXTENSION_IDS) {
    if (vscode.extensions.getExtension(extensionId)) {
      return extensionId;
    }
  }
  return null;
}

function buildClaudeVsCodeUri(prompt: string, sessionId?: string): vscode.Uri {
  const query = new URLSearchParams();
  query.set("prompt", prompt);
  if (sessionId) {
    query.set("session", sessionId);
  }
  return vscode.Uri.parse(`vscode://anthropic.claude-code/open?${query.toString()}`);
}
