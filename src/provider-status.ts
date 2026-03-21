import type { ProviderStatusInfo } from "./tasks/types";

export function getProviderStatusLabel(status: ProviderStatusInfo): string {
  return status.label;
}

export function getProviderDiagnosisMessage(status: ProviderStatusInfo): { message: string; detail: string } {
  return {
    message: status.message,
    detail: status.detail,
  };
}
