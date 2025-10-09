#!/usr/bin/env -S deno run --allow-all

/**
 * Main Mautic Docker Compose Setup Script
 * 
 * This is the entry point that orchestrates the entire deployment process
 * using modular TypeScript components for better maintainability.
 */

import { Logger } from './logger.ts';
import { ProcessManager } from './process-manager.ts';
import { PackageManager } from './package-manager.ts';
import { DockerManager } from './docker-manager.ts';
import { MauticDeployer } from './mautic-deployer.ts';
import { SSLManager } from './ssl-manager.ts';
import { loadDeploymentConfig } from './config.ts';

async function main() {
  try {
    // Start with immediate console output before logger init
    console.log('🚀 Mautic setup binary starting...');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Deno version: ${Deno.version.deno}`);
    console.log(`Platform: ${Deno.build.os}-${Deno.build.arch}`);
    
    Logger.log('Starting Mautic Docker Compose setup...', '🚀');
    Logger.log(`Timestamp: ${new Date().toISOString()}`);
    
    // Initialize logging
    await Logger.init();
    
    // Wait for VPS initialization
    Logger.log('Waiting for VPS initialization to complete...', '⏳');
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // Environment check
    Logger.log('Environment check:', '🔍');
    const user = await ProcessManager.runShell('whoami');
    const pwd = await ProcessManager.runShell('pwd');
    const dockerVersion = await ProcessManager.runShell('docker --version', { ignoreError: true });
    
    Logger.log(`  - Current user: ${user.output}`);
    Logger.log(`  - Current directory: ${pwd.output}`);
    Logger.log(`  - Docker version: ${dockerVersion.output || 'Not available'}`);
    
    // Load configuration
    Logger.log('Loading deployment configuration...', '📋');
    const config = await loadDeploymentConfig();
    Logger.success('Configuration loaded and validated');
    
    // Stop unattended upgrades
    Logger.log('Stopping unattended-upgrades to prevent lock conflicts...', '🛑');
    await ProcessManager.runShell('systemctl stop unattended-upgrades', { ignoreError: true });
    await ProcessManager.runShell('systemctl disable unattended-upgrades', { ignoreError: true });
    await ProcessManager.runShell('pkill -f unattended-upgrade', { ignoreError: true });
    
    // Handle package installation
    await PackageManager.waitForLocks();
    await PackageManager.updatePackages();
    
    // Install required packages
    const packages = ['curl', 'wget', 'unzip', 'git', 'nano', 'htop', 'cron', 'netcat'];
    if (config.domainName) {
      packages.push('nginx', 'certbot', 'python3-certbot-nginx');
    }
    
    for (const pkg of packages) {
      await PackageManager.installPackage(pkg);
    }
    
    // Initialize deployment manager
    const deployer = new MauticDeployer(config);
    const sslManager = new SSLManager(config);
    
    // Check if Mautic is already installed
    const isInstalled = await deployer.isInstalled();
    
    if (isInstalled) {
      Logger.success('Existing Mautic installation detected');
      
      // Check if update is needed
      const needsUpdate = await deployer.needsUpdate();
      
      if (needsUpdate) {
        Logger.log('Update required, performing version update...', '🔄');
        const updateSuccess = await deployer.performUpdate();
        
        if (!updateSuccess) {
          throw new Error('Failed to update Mautic');
        }
      } else {
        Logger.success('Mautic is already up to date, no changes needed');
      }
    } else {
      Logger.log('No existing installation found, performing fresh installation...', '🆕');
      const installSuccess = await deployer.performInstallation();
      
      if (!installSuccess) {
        throw new Error('Failed to install Mautic');
      }
    }
    
    // Setup SSL if domain is provided
    if (config.domainName) {
      await sslManager.setupSSL();
    }
    
    // Final validation
    Logger.log('Performing final system validation...', '✅');
    const containers = await DockerManager.listMauticContainers();
    Logger.log(`Active containers: ${containers.length}`);
    
    for (const container of containers) {
      Logger.log(`  - ${container.name}: ${container.status} (${container.image})`);
    }
    
    // Test HTTP connectivity
    const baseUrl = config.domainName 
      ? `http://${config.domainName}`
      : `http://${config.ipAddress}:${config.port}`;
    const testUrl = `${baseUrl}/s/login`;
    
    Logger.log(`Testing connectivity to: ${testUrl}`, '🌐');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      const curlResult = await ProcessManager.runShell(
        `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 30 "${testUrl}"`,
        { ignoreError: true }
      );
      
      if (curlResult.success && curlResult.output === '200') {
        Logger.success('✅ HTTP connectivity test passed');
        break;
      } else if (attempt === 3) {
        Logger.warning(`⚠️ HTTP test failed after 3 attempts (status: ${curlResult.output})`);
      } else {
        Logger.log(`HTTP test attempt ${attempt}/3 failed, retrying...`, '🔄');
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
    }
    
    Logger.success('🎉 Mautic setup completed successfully!');
    Logger.log(`📍 Access URL: ${testUrl}`);
    Logger.log(`📧 Admin email: ${config.emailAddress}`);
    Logger.log(`🔒 Admin password: [configured]`);
    
    // Set output variables for GitHub Actions (use base URL for mautic_url)
    console.log(`::set-output name=mautic_url::${baseUrl}`);
    console.log(`::set-output name=admin_email::${config.emailAddress}`);
    console.log(`::set-output name=deployment_status::success`);

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    Logger.error(`Setup failed: ${errorMessage}`);
    Deno.exit(1);
  }
}

// Main execution
if (import.meta.main) {
  main();
}