/**
 * SSL certificate management with Nginx
 */

import type { DeploymentConfig } from './types.ts';
import { Logger } from './logger.ts';
import { ProcessManager } from './process-manager.ts';

export class SSLManager {
  private config: DeploymentConfig;
  
  constructor(config: DeploymentConfig) {
    this.config = config;
  }
  
  async setupSSL(): Promise<boolean> {
    if (!this.config.domainName) {
      Logger.info('No domain specified, skipping SSL setup');
      return true;
    }
    
    Logger.log(`Setting up SSL for domain: ${this.config.domainName}`, '🔒');
    
    try {
      // Setup Nginx
      await this.setupNginx();
      
      // Generate SSL certificate
      const certSuccess = await this.generateCertificate();
      
      if (!certSuccess) {
        Logger.warning('SSL certificate generation failed, but continuing...');
        return false;
      }
      
      Logger.success('SSL setup completed successfully');
      return true;
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`SSL setup failed: ${errorMessage}`);
      return false;
    }
  }
  
  private async setupNginx(): Promise<void> {
    Logger.log('Configuring Nginx...', '🌐');
    
    const nginxConfig = `
server {
    listen 80;
    server_name ${this.config.domainName};
    
    location / {
        proxy_pass http://localhost:${this.config.port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`.trim();
    
    await Deno.writeTextFile(`/etc/nginx/sites-available/${this.config.domainName}`, nginxConfig);
    
    // Enable site
    await ProcessManager.runShell(`ln -sf /etc/nginx/sites-available/${this.config.domainName} /etc/nginx/sites-enabled/`);
    
    // Test and reload Nginx
    const testResult = await ProcessManager.runShell('nginx -t', { ignoreError: true });
    if (testResult.success) {
      await ProcessManager.runShell('systemctl reload nginx');
      Logger.success('Nginx configured successfully');
    } else {
      throw new Error(`Nginx configuration test failed: ${testResult.output}`);
    }
  }
  
  private async generateCertificate(): Promise<boolean> {
    Logger.log('Generating SSL certificate...', '🔐');
    
    const certbotResult = await ProcessManager.runShell(
      `certbot --nginx -d ${this.config.domainName} --non-interactive --agree-tos --email ${this.config.emailAddress} --redirect`,
      { ignoreError: true }
    );
    
    if (certbotResult.success) {
      Logger.success('SSL certificate generated successfully');
      return true;
    } else {
      Logger.error(`Certbot failed: ${certbotResult.output}`);
      return false;
    }
  }
}