/**
 * Type definitions for Mautic deployment system
 */

export interface DeploymentConfig {
  emailAddress: string;
  mauticPassword: string;
  ipAddress: string;
  port: string;
  mauticVersion: string;
  mauticThemes?: string;
  mauticPlugins?: string;
  mysqlDatabase: string;
  mysqlUser: string;
  mysqlPassword: string;
  mysqlRootPassword: string;
  domainName?: string;
}

export interface ContainerInfo {
  name: string;
  image: string;
  status: string;
  health?: string | undefined;
}

export interface ProcessResult {
  success: boolean;
  output: string;
  exitCode: number;
}

export interface ProcessOptions {
  cwd?: string;
  timeout?: number;
  ignoreError?: boolean;
}