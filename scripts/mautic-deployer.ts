/**
 * Main Mautic deployment logic
 */

import type { DeploymentConfig } from './types.ts';
import { Logger } from './logger.ts';
import { ProcessManager } from './process-manager.ts';
import { DockerManager } from './docker-manager.ts';

export class MauticDeployer {
  private config: DeploymentConfig;
  
  constructor(config: DeploymentConfig) {
    this.config = config;
  }
  
  async isInstalled(): Promise<boolean> {
    // Check multiple indicators for installation
    const checks = [
      this.checkDockerCompose(),
      this.checkMauticDirectories(),
      this.checkDatabase(),
      this.checkConfigFiles()
    ];
    
    const results = await Promise.all(checks);
    const passedChecks = results.filter(Boolean).length;
    
    Logger.log(`Installation checks: ${passedChecks}/4 passed`, '📊');
    
    // Consider installed if at least 3 checks pass
    return passedChecks >= 3;
  }
  
  private async checkDockerCompose(): Promise<boolean> {
    const result = await ProcessManager.runShell('test -f docker-compose.yml', { ignoreError: true });
    if (result.success) {
      Logger.success('✓ docker-compose.yml exists');
      return true;
    } else {
      Logger.info('✗ docker-compose.yml not found');
      return false;
    }
  }
  
  private async checkMauticDirectories(): Promise<boolean> {
    const result = await ProcessManager.runShell('test -d mautic_data && test -d mysql_data', { ignoreError: true });
    if (result.success) {
      Logger.success('✓ Mautic data directories exist');
      return true;
    } else {
      Logger.info('✗ Mautic data directories not found');
      return false;
    }
  }
  
  private async checkDatabase(): Promise<boolean> {
    const containers = await DockerManager.listMauticContainers();
    const dbContainer = containers.find(c => c.name === 'mautic_db');
    
    if (dbContainer && dbContainer.status === 'running') {
      Logger.success('✓ Database container is running');
      return true;
    } else {
      Logger.info('✗ Database container not running');
      return false;
    }
  }
  
  private async checkConfigFiles(): Promise<boolean> {
    const result = await ProcessManager.runShell('test -f .mautic_env', { ignoreError: true });
    if (result.success) {
      Logger.success('✓ Configuration files exist');
      return true;
    } else {
      Logger.info('✗ Configuration files not found');
      return false;
    }
  }
  
  async needsUpdate(): Promise<boolean> {
    const currentVersion = await DockerManager.getCurrentMauticVersion();
    const targetVersion = this.config.mauticVersion;
    
    if (!currentVersion) {
      Logger.log('No current version found, update needed', '🔄');
      return true;
    }
    
    if (currentVersion !== targetVersion) {
      Logger.log(`Version mismatch: current=${currentVersion}, target=${targetVersion}`, '🔄');
      return true;
    }
    
    Logger.success(`Version up to date: ${currentVersion}`);
    return false;
  }
  
  async performUpdate(): Promise<boolean> {
    Logger.log('Performing Mautic update...', '🔄');
    
    try {
      // Pull new image - handle version that may already include -apache suffix
      const baseVersion = this.config.mauticVersion.endsWith('-apache') 
        ? this.config.mauticVersion 
        : `${this.config.mauticVersion}-apache`;
      const imageName = `mautic/mautic:${baseVersion}`;
      const pullSuccess = await DockerManager.pullImage(imageName);
      
      if (!pullSuccess) {
        throw new Error('Failed to pull new Mautic image');
      }
      
      // Update docker-compose.yml with new version
      await this.updateDockerComposeVersion();
      
      // Recreate containers with new image
      const recreateSuccess = await DockerManager.recreateContainers();
      
      if (!recreateSuccess) {
        throw new Error('Failed to recreate containers');
      }
      
      // Wait for containers to be healthy
      const healthyWeb = await DockerManager.waitForHealthy('mautic_web');
      const healthyDb = await DockerManager.waitForHealthy('mautic_db');
      
      if (!healthyWeb || !healthyDb) {
        throw new Error('Containers failed to become healthy after update');
      }
      
      // Warm up cache after update
      await this.warmupCache();
      
      Logger.success('Mautic update completed successfully');
      return true;
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Update failed: ${errorMessage}`);
      return false;
    }
  }
  
  private async updateDockerComposeVersion(): Promise<void> {
    Logger.log('Updating docker-compose.yml with new version...', '📝');
    
    try {
      const composeContent = await Deno.readTextFile('docker-compose.yml');
      const baseVersion = this.config.mauticVersion.endsWith('-apache') 
        ? this.config.mauticVersion 
        : `${this.config.mauticVersion}-apache`;
      const updatedContent = composeContent.replace(
        /mautic\/mautic:[^-]+-apache/g,
        `mautic/mautic:${baseVersion}`
      );
      
      await Deno.writeTextFile('docker-compose.yml', updatedContent);
      Logger.success('docker-compose.yml updated');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to update docker-compose.yml: ${errorMessage}`);
    }
  }
  
  async performInstallation(): Promise<boolean> {
    Logger.log('Performing fresh Mautic installation...', '🚀');
    
    try {
      // Create data directories
      await ProcessManager.runShell('mkdir -p mautic_data mysql_data logs');
      await ProcessManager.runShell('chmod 755 mautic_data mysql_data logs');
      
      // Generate environment file
      await this.createEnvironmentFile();
      
      // Create docker-compose.yml from template
      await this.createDockerCompose();
      
      // Start containers
      const startSuccess = await DockerManager.recreateContainers();
      
      if (!startSuccess) {
        throw new Error('Failed to start containers');
      }
      
      // Wait for services to be ready
      await DockerManager.waitForHealthy('mautic_db', 180);
      await DockerManager.waitForHealthy('mautic_web', 300);
      
      // Run Mautic installation inside the container
      await this.runMauticInstallation();
      
      // Warm up Mautic cache for better performance
      await this.warmupCache();
      
      // Install themes and plugins if specified
      if (this.config.mauticThemes || this.config.mauticPlugins) {
        await this.installThemesAndPlugins();
        // Warm up cache again after installing packages
        await this.warmupCache();
      }
      
      Logger.success('Mautic installation completed successfully');
      return true;
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Installation failed: ${errorMessage}`);
      return false;
    }
  }
  
  private async createEnvironmentFile(): Promise<void> {
    Logger.log('Creating environment configuration...', '⚙️');
    
    const envContent = `
# Mautic Configuration
MAUTIC_DB_HOST=mautic_db
MAUTIC_DB_USER=${this.config.mysqlUser}
MAUTIC_DB_PASSWORD=${this.config.mysqlPassword}
MAUTIC_DB_NAME=${this.config.mysqlDatabase}
MAUTIC_DB_PORT=3306
MAUTIC_TRUSTED_PROXIES=["0.0.0.0/0"]
MAUTIC_RUN_CRON_JOBS=true
DOCKER_MAUTIC_ROLE=mautic_web

# MySQL Configuration  
MYSQL_ROOT_PASSWORD=${this.config.mysqlRootPassword}
MYSQL_DATABASE=${this.config.mysqlDatabase}
MYSQL_USER=${this.config.mysqlUser}
MYSQL_PASSWORD=${this.config.mysqlPassword}

# Deployment Configuration
IP_ADDRESS=${this.config.ipAddress}
PORT=${this.config.port}
DOMAIN_NAME=${this.config.domainName || ''}
EMAIL_ADDRESS=${this.config.emailAddress}
MAUTIC_VERSION=${this.config.mauticVersion}
MAUTIC_PASSWORD=${this.config.mauticPassword}
MAUTIC_THEMES=${this.config.mauticThemes || ''}
MAUTIC_PLUGINS=${this.config.mauticPlugins || ''}
`.trim();
    
    await Deno.writeTextFile('.mautic_env', envContent);
    await Deno.chmod('.mautic_env', 0o600);
    
    Logger.success('Environment file created');
  }
  
  private async createDockerCompose(): Promise<void> {
    Logger.log('Creating docker-compose.yml...', '🐳');
    
    // Handle version that may already include -apache suffix
    const baseVersion = this.config.mauticVersion.endsWith('-apache') 
      ? this.config.mauticVersion 
      : `${this.config.mauticVersion}-apache`;
    
    const composeContent = `
version: '3.8'

services:
  mautic_web:
    image: mautic/mautic:${baseVersion}
    container_name: mautic_web
    restart: unless-stopped
    ports:
      - "${this.config.port}:80"
    volumes:
      - mautic_data:/var/www/html
      - ./logs:/var/www/html/var/logs
    environment:
      - MAUTIC_DB_HOST=mautic_db
      - MAUTIC_DB_USER=${this.config.mysqlUser}
      - MAUTIC_DB_PASSWORD=${this.config.mysqlPassword}
      - MAUTIC_DB_NAME=${this.config.mysqlDatabase}
      - MAUTIC_DB_PORT=3306
      - MAUTIC_TRUSTED_PROXIES=["0.0.0.0/0"]
      - MAUTIC_RUN_CRON_JOBS=true
      - DOCKER_MAUTIC_ROLE=mautic_web
    depends_on:
      mautic_db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 120s

  mautic_cron:
    image: mautic/mautic:${baseVersion}
    container_name: mautic_cron
    restart: unless-stopped
    volumes:
      - mautic_data:/var/www/html
      - ./logs:/var/www/html/var/logs
    environment:
      - MAUTIC_DB_HOST=mautic_db
      - MAUTIC_DB_USER=${this.config.mysqlUser}
      - MAUTIC_DB_PASSWORD=${this.config.mysqlPassword}
      - MAUTIC_DB_NAME=${this.config.mysqlDatabase}
      - MAUTIC_DB_PORT=3306
      - MAUTIC_RUN_CRON_JOBS=true
      - DOCKER_MAUTIC_ROLE=mautic_cron
    depends_on:
      mautic_db:
        condition: service_healthy
    command: ["sh", "-c", "while true; do php /var/www/html/bin/console mautic:segments:update && php /var/www/html/bin/console mautic:campaigns:update && php /var/www/html/bin/console mautic:campaigns:trigger && sleep 300; done"]

  mautic_db:
    image: mysql:8.0
    container_name: mautic_db
    restart: unless-stopped
    environment:
      - MYSQL_ROOT_PASSWORD=${this.config.mysqlRootPassword}
      - MYSQL_DATABASE=${this.config.mysqlDatabase}
      - MYSQL_USER=${this.config.mysqlUser}
      - MYSQL_PASSWORD=${this.config.mysqlPassword}
    volumes:
      - ./mysql_data:/var/lib/mysql
    command: mysqld --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --innodb-file-per-table=1 --innodb-buffer-pool-size=1G --max_allowed_packet=512M
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-p${this.config.mysqlRootPassword}"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s

volumes:
  mautic_data:
  mysql_data:
`.trim();
    
    await Deno.writeTextFile('docker-compose.yml', composeContent);
    Logger.success('docker-compose.yml created');
  }
  
  private async installThemesAndPlugins(): Promise<void> {
    Logger.log('Installing themes and plugins...', '🎨');
    
    // Install themes
    if (this.config.mauticThemes) {
      const themes = this.config.mauticThemes.split(',').map(t => t.trim());
      for (const theme of themes) {
        await this.installTheme(theme);
      }
    }
    
    // Install plugins
    if (this.config.mauticPlugins) {
      const plugins = this.config.mauticPlugins.split(',').map(p => p.trim());
      for (const plugin of plugins) {
        await this.installPlugin(plugin);
      }
    }
  }
  
  private async installTheme(themeUrl: string): Promise<void> {
    Logger.log(`Installing theme: ${themeUrl}`, '🎨');
    
    try {
      await ProcessManager.runShell(`
        cd mautic_data/themes &&
        wget -O theme.zip "${themeUrl}" &&
        unzip -o theme.zip &&
        rm theme.zip
      `, { ignoreError: true });
      
      Logger.success(`Theme installed: ${themeUrl}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Failed to install theme ${themeUrl}: ${errorMessage}`);
    }
  }
  
  private async installPlugin(pluginUrl: string): Promise<void> {
    Logger.log(`Installing plugin: ${pluginUrl}`, '🔌');
    
    try {
      await ProcessManager.runShell(`
        cd mautic_data/plugins &&
        wget -O plugin.zip "${pluginUrl}" &&
        unzip -o plugin.zip &&
        rm plugin.zip
      `, { ignoreError: true });
      
      Logger.success(`Plugin installed: ${pluginUrl}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Failed to install plugin ${pluginUrl}: ${errorMessage}`);
    }
  }

  /**
   * Run Mautic installation inside the container with streaming output
   */
  private async runMauticInstallation(): Promise<void> {
    Logger.info('🔧 Running Mautic installation...');
    
    try {
      // First, let's ensure the container is ready and database is accessible
      Logger.log('Pre-installation check: Testing database connection...', '🔍');
      try {
        const dbTest = await ProcessManager.run([
          'docker', 'exec', 'mautic_web', 
          'php', '-r', 
          `try { $pdo = new PDO('mysql:host=mautic_db;dbname=${this.config.mysqlDatabase}', '${this.config.mysqlUser}', '${this.config.mysqlPassword}'); echo 'DB_CONNECTION_OK'; } catch(Exception $e) { echo 'DB_ERROR: ' . $e->getMessage(); }`
        ]);
        Logger.log(`Database test result: ${dbTest.output}`, '📊');
      } catch (error) {
        Logger.log(`Database test failed: ${error}`, '⚠️');
      }
      
      // Check if mautic:install command help works
      Logger.log('Testing mautic:install command availability...', '🔍');
      try {
        const helpResult = await ProcessManager.run([
          'docker', 'exec', 'mautic_web', 
          'timeout', '30',  // 30 second timeout
          'php', '/var/www/html/bin/console', 'mautic:install', '--help'
        ]);
        Logger.log(`Install command available: ${helpResult.success ? 'YES' : 'NO'}`, '✅');
        if (helpResult.output.includes('site_url')) {
          Logger.log('Command signature confirmed', '✅');
        }
      } catch (error) {
        Logger.log(`Install command test failed: ${error}`, '❌');
        throw new Error('mautic:install command not available or hanging');
      }
      
      // Run the actual installation with timeout
      Logger.log('Starting Mautic installation with 5-minute timeout...', '🚀');
      
      const siteUrl = this.config.domainName 
        ? `https://${this.config.domainName}` 
        : `http://${this.config.ipAddress}:${this.config.port}`;
      
      Logger.log(`Site URL: ${siteUrl}`, '🌐');
      Logger.log('Database: mautic_db', '🗄️');
      Logger.log(`Admin email: ${this.config.emailAddress}`, '👤');
      
      const installResult = await ProcessManager.run([
        'docker', 'exec', 'mautic_web', 
        'timeout', '300',  // 5 minute timeout
        'php', '/var/www/html/bin/console', 'mautic:install',
        siteUrl,
        '--db_host=mautic_db',
        '--db_name=' + this.config.mysqlDatabase,
        '--db_user=' + this.config.mysqlUser,
        '--db_password=' + this.config.mysqlPassword,
        '--admin_firstname=Admin',
        '--admin_lastname=User',
        '--admin_username=admin',
        '--admin_email=' + this.config.emailAddress,
        '--admin_password=' + this.config.mauticPassword,
        '--force',
        '--no-interaction',
        '-vvv'
      ]);
      
      Logger.log(`Installation result (exit code: ${installResult.exitCode}):`, '📋');
      Logger.log(installResult.output, '📄');
      
      if (installResult.success) {
        Logger.success('✅ Mautic installation completed successfully');
      } else if (installResult.output.includes('timeout')) {
        throw new Error('Installation timed out after 5 minutes');
      } else {
        throw new Error(`Installation failed with exit code ${installResult.exitCode}: ${installResult.output}`);
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Mautic installation failed: ${errorMessage}`);
      throw new Error(`Mautic installation failed: ${errorMessage}`);
    }
  }

  /**
   * Warm up Mautic cache for better performance
   */
  private async warmupCache(): Promise<void> {
    Logger.info('🔥 Warming up Mautic cache...');
    
    try {
      // Clear existing cache first
      await ProcessManager.run([
        'docker', 'exec', 'mautic_web', 
        'php', '/var/www/html/bin/console', 'cache:clear', '--env=prod'
      ]);
      
      // Warm up cache
      await ProcessManager.run([
        'docker', 'exec', 'mautic_web', 
        'php', '/var/www/html/bin/console', 'cache:warmup', '--env=prod'
      ]);
      
      Logger.success('✅ Cache warmup completed');
    } catch (error) {
      // Cache warmup is not critical - log but don't fail deployment
      Logger.error(`⚠️ Cache warmup failed (non-critical): ${error}`);
    }
  }
}