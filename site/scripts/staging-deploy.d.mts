export const REQUIRED_STAGING_SECRETS: readonly string[];

export function assertStagingConfig(config: unknown): void;

export function missingRequiredSecrets(secrets: unknown): string[];

export function validateCapabilityDocument(value: unknown): {
  readonly account: boolean;
  readonly managedTerminal: boolean;
};

export function stagingDeployArguments(secretsFile?: string): string[];
