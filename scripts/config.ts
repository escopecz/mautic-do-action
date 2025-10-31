/**
 * Configuration loading and validation
 */

import type { DeploymentConfig } from './types.ts';

export async function loadDeploymentConfig(): Promise<DeploymentConfig> {
  try {
    const envContent = await Deno.readTextFile('deploy.env');
    const config: any = {};
    
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key) {
          config[key] = valueParts.join('=');
        }
      }
    }
    
    // Validate required fields
    const required = [
      'EMAIL_ADDRESS', 'MAUTIC_PASSWORD', 'IP_ADDRESS', 'PORT', 'MAUTIC_VERSION',
      'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD'
    ];
    
    for (const field of required) {
      if (!config[field]) {
        throw new Error(`Required variable ${field} is not set`);
      }
    }
    
    return {
      emailAddress: config.EMAIL_ADDRESS,
      mauticPassword: config.MAUTIC_PASSWORD,
      ipAddress: config.IP_ADDRESS,
      port: config.PORT,
      mauticVersion: config.MAUTIC_VERSION,
      mauticThemes: config.MAUTIC_THEMES,
      mauticPlugins: config.MAUTIC_PLUGINS,
      mysqlDatabase: config.MYSQL_DATABASE,
      mysqlUser: config.MYSQL_USER,
      mysqlPassword: config.MYSQL_PASSWORD,
      mysqlRootPassword: config.MYSQL_ROOT_PASSWORD,
      domainName: config.DOMAIN_NAME,
      githubToken: config.GITHUB_TOKEN
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to load deployment configuration: ${errorMessage}`);
  }
}