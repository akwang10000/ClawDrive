import * as vscode from "vscode";
import { getOutputChannel } from "./logger";
import { taskResultTitle, taskStateLabel } from "./tasks/text";
import type { TaskService } from "./tasks/service";
import type { TaskDecisionOption, TaskSnapshot } from "./tasks/types";

class TaskTreeItem extends vscode.TreeItem {
  constructor(readonly snapshot: TaskSnapshot) {
    super(snapshot.title, vscode.TreeItemCollapsibleState.None);
    this.id = snapshot.taskId;
    this.description = taskStateLabel(snapshot.state);
    this.tooltip = `${snapshot.summary}\n${snapshot.updatedAt}`;
    this.contextValue = `task:${snapshot.state}`;
    this.iconPath = this.iconForState(snapshot.state);
    this.command = {
      command: "clawdrive.activity.openResult",
      title: "Open Result",
      arguments: [snapshot.taskId],
    };
  }

  private iconForState(state: TaskSnapshot["state"]): vscode.ThemeIcon {
    switch (state) {
      case "completed":
        return new vscode.ThemeIcon("check");
      case "failed":
        return new vscode.ThemeIcon("error");
      case "waiting_decision":
        return new vscode.ThemeIcon("question");
      case "running":
        return new vscode.ThemeIcon("sync~spin");
      case "cancelled":
        return new vscode.ThemeIcon("circle-slash");
      case "interrupted":
        return new vscode.ThemeIcon("debug-pause");
      default:
        return new vscode.ThemeIcon("clock");
    }
  }
}

export class ClawDriveActivityProvider implements vscode.TreeDataProvider<TaskTreeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TaskTreeItem | void>();

  constructor(private readonly taskService: TaskService) {}

  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): TaskTreeItem[] {
    return this.taskService.listTasks({ limit: 50 }).map((snapshot) => new TaskTreeItem(snapshot));
  }

  async openResult(taskId: string): Promise<void> {
    const result = await this.taskService.getTaskResult(taskId);
    const output = getOutputChannel();
    output.show(true);
    output.appendLine("");
    output.appendLine(taskResultTitle(result.snapshot.title, result.snapshot.state));
    output.appendLine(result.snapshot.summary);
    if (result.snapshot.errorCode) {
      output.appendLine(`Error code: ${result.snapshot.errorCode}`);
    }
    if (result.snapshot.decision) {
      output.appendLine("Decision:");
      for (const option of result.snapshot.decision.options) {
        output.appendLine(this.formatOption(option, option.id === result.snapshot.decision.recommendedOptionId));
      }
    }
    if (result.snapshot.lastOutput) {
      output.appendLine("");
      output.appendLine(result.snapshot.lastOutput);
    }
    if (result.events.length) {
      output.appendLine("");
      output.appendLine("Events:");
      for (const event of result.events) {
        output.appendLine(`${event.at}  ${event.type}  ${event.summary}`);
        if (event.detail) {
          output.appendLine(`      ${event.detail}`);
        }
      }
    }
  }

  async continueTask(taskId: string): Promise<void> {
    const snapshot = this.taskService.getTask(taskId);
    if (snapshot.state === "waiting_decision" && snapshot.decision?.options.length) {
      const picked = await vscode.window.showQuickPick(
        snapshot.decision.options.map((option) => ({
          label: option.title,
          description: option.id === snapshot.decision?.recommendedOptionId ? "Recommended" : "",
          detail: option.summary,
          optionId: option.id,
        })),
        { placeHolder: "Choose an option to continue" }
      );
      if (!picked) {
        return;
      }
      await this.taskService.respondToTask({ taskId, optionId: picked.optionId });
      return;
    }

    if (snapshot.state === "interrupted") {
      await this.taskService.respondToTask({
        taskId,
        message: "Continue the interrupted task without modifying files.",
      });
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private formatOption(option: TaskDecisionOption, recommended: boolean): string {
    return recommended ? `* ${option.id}: ${option.title} - ${option.summary}` : `- ${option.id}: ${option.title} - ${option.summary}`;
  }
}
