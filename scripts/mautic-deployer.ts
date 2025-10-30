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
      
      // Clear cache after update
      await this.clearCache('after update');
      
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
      
      // Debug: Verify environment file was created correctly
      Logger.log('Verifying environment file creation...', '🔍');
      const envCheckResult = await ProcessManager.runShell('ls -la .mautic_env', { ignoreError: true });
      if (envCheckResult.success) {
        Logger.log('Environment file exists:', '✅');
        Logger.log(envCheckResult.output, '📋');
        
        // Check the content (but mask sensitive values)
        const envContentResult = await ProcessManager.runShell('head -10 .mautic_env | sed "s/=.*/=***MASKED***/"', { ignoreError: true });
        if (envContentResult.success) {
          Logger.log('Environment file structure (values masked):', '📄');
          Logger.log(envContentResult.output, '📋');
        }
      } else {
        Logger.error('Environment file was not created!');
        Logger.log(envCheckResult.output, '❌');
      }
      
      // Create docker-compose.yml from template
      await this.createDockerCompose();
      
      // Start containers
      const startSuccess = await DockerManager.recreateContainers();
      
      if (!startSuccess) {
        // Debug: Check what docker-compose.yml looks like when it fails
        Logger.log('Container startup failed - checking docker-compose.yml content...', '🔍');
        const composeResult = await ProcessManager.runShell('head -50 docker-compose.yml', { ignoreError: true });
        if (composeResult.success) {
          Logger.log('docker-compose.yml content (first 50 lines):', '📄');
          Logger.log(composeResult.output, '📋');
        }
        
        // Check what containers exist
        Logger.log('Checking Docker container status after failure...', '🐳');
        const containerResult = await ProcessManager.runShell('docker ps -a', { ignoreError: true });
        if (containerResult.success) {
          Logger.log('All Docker containers after failure:', '📋');
          Logger.log(containerResult.output, '📋');
        }
        
        throw new Error('Failed to start containers');
      }
      
      Logger.log('Containers started, checking initial status...', '📊');
      
      // Quick container status check
      const initialContainers = await DockerManager.listMauticContainers();
      for (const container of initialContainers) {
        Logger.log(`Container ${container.name}: ${container.status} (${container.image})`, '📦');
      }
      
      // Immediate MySQL debugging - check right after startup
      Logger.log('Checking MySQL container immediately after startup...', '🔍');
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
      
      const mysqlLogs = await ProcessManager.runShell('docker logs mautic_db --tail 20', { ignoreError: true });
      if (mysqlLogs.success) {
        Logger.log('MySQL startup logs:', '📋');
        Logger.log(mysqlLogs.output, '📄');
      }
      
      // Wait for services to be ready
      Logger.log('Waiting for database to be healthy (up to 3 minutes)...', '🗄️');
      await DockerManager.waitForHealthy('mautic_db', 180);
      
      Logger.log('Waiting for Mautic web container to be healthy (up to 5 minutes)...', '🌐');
      await DockerManager.waitForHealthy('mautic_web', 300);
      
      // Run Mautic installation inside the container
      await this.runMauticInstallation();
      
      // Clear cache after installation
      await this.clearCache('after installation');
      
      // Install themes and plugins if specified
      if (this.config.mauticThemes || this.config.mauticPlugins) {
        await this.installThemesAndPlugins();
        // Clear cache after installing packages
        await this.clearCache('after installing themes/plugins');
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
# Database Configuration
MAUTIC_DB_HOST=mysql
MAUTIC_DB_USER=${this.config.mysqlUser}
MAUTIC_DB_PASSWORD=${this.config.mysqlPassword}
MAUTIC_DB_DATABASE=${this.config.mysqlDatabase}
MAUTIC_DB_PORT=3306

# Mautic Configuration
MAUTIC_TRUSTED_PROXIES=["0.0.0.0/0"]
MAUTIC_RUN_CRON_JOBS=true

# Admin Configuration
MAUTIC_ADMIN_EMAIL=${this.config.emailAddress}
MAUTIC_ADMIN_PASSWORD=${this.config.mauticPassword}
MAUTIC_ADMIN_FIRSTNAME=Admin
MAUTIC_ADMIN_LASTNAME=User

# Docker Configuration - will be overridden per container
DOCKER_MAUTIC_ROLE=mautic_web

# Installation Configuration
MAUTIC_DB_PREFIX=
MAUTIC_INSTALL_FORCE=true

# MySQL Configuration (for docker-compose environment variables)
MYSQL_ROOT_PASSWORD=${this.config.mysqlRootPassword}
MYSQL_DATABASE=${this.config.mysqlDatabase}
MYSQL_USER=${this.config.mysqlUser}
MYSQL_PASSWORD=${this.config.mysqlPassword}

# Deployment Configuration
MAUTIC_VERSION=${this.config.mauticVersion.endsWith('-apache') ? this.config.mauticVersion : `${this.config.mauticVersion}-apache`}
PORT=${this.config.port}
`.trim();
    
    await Deno.writeTextFile('.mautic_env', envContent);
    await Deno.chmod('.mautic_env', 0o600);
    
    Logger.success('Environment file created');
  }
  
  private async createDockerCompose(): Promise<void> {
    Logger.log('Creating docker-compose.yml from template...', '🐳');
    
    try {
      // Template should already be copied to current directory by deploy.sh
      // If not, try to copy it from the action path
      const templateExists = await ProcessManager.runShell('test -f docker-compose.yml', { ignoreError: true });
      
      if (!templateExists.success) {
        Logger.log('Template not found in current directory, this should have been copied by deploy.sh', '⚠️');
        throw new Error('docker-compose.yml template not found. It should be copied by deploy.sh.');
      }
      
      Logger.success('docker-compose.yml template ready');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to prepare docker-compose.yml: ${errorMessage}`);
    }
  }
  
  private async installThemesAndPlugins(): Promise<void> {
    Logger.log('Installing themes and plugins...', '🎨');
    
    // Check if we should use the custom Docker image approach or runtime installation
    const useCustomImage = await this.shouldUseCustomImageApproach();
    
    if (useCustomImage) {
      await this.buildCustomMauticImage();
    } else {
      // Fallback to runtime installation for backward compatibility
      await this.installThemesAndPluginsRuntime();
    }
  }

  private async shouldUseCustomImageApproach(): Promise<boolean> {
    // Use custom image approach if we have plugins/themes to install
    return !!(this.config.mauticThemes || this.config.mauticPlugins);
  }

  private async buildCustomMauticImage(): Promise<void> {
    Logger.log('Building custom Mautic image with plugins/themes...', '🏗️');
    
    try {
      // Create build directory
      await ProcessManager.runShell('mkdir -p build/plugins build/themes');
      
      // Copy Dockerfile template
      await ProcessManager.runShell('cp templates/Dockerfile.custom build/Dockerfile');
      
      // Download and prepare plugins/themes
      await this.prepareCustomContent();
      
      // Build custom image
      const imageName = `mautic-custom:${this.config.mauticVersion}`;
      const baseVersion = this.config.mauticVersion.endsWith('-apache') 
        ? this.config.mauticVersion 
        : `${this.config.mauticVersion}-apache`;
      
      const buildCommand = `cd build && docker build --build-arg MAUTIC_VERSION=${baseVersion} -t ${imageName} .`;
      const buildSuccess = await ProcessManager.runShell(buildCommand);
      
      if (!buildSuccess.success) {
        throw new Error('Failed to build custom Mautic image');
      }
      
      // Update docker-compose to use custom image
      await this.updateComposeForCustomImage(imageName);
      
      Logger.success('Custom Mautic image built successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Failed to build custom image: ${errorMessage}`);
      throw error;
    }
  }

  private async prepareCustomContent(): Promise<void> {
    // Install themes
    if (this.config.mauticThemes) {
      const themes = this.config.mauticThemes.split(',').map(t => t.trim());
      for (const theme of themes) {
        await this.downloadTheme(theme);
      }
    }
    
    // Install plugins
    if (this.config.mauticPlugins) {
      const plugins = this.config.mauticPlugins.split(',').map(p => p.trim());
      for (const plugin of plugins) {
        await this.downloadPlugin(plugin);
      }
    }
  }

  private async downloadTheme(themeUrl: string): Promise<void> {
    Logger.log(`Downloading theme: ${themeUrl}`, '🎨');
    
    try {
      const fileName = `theme-${Date.now()}.zip`;
      const downloadPath = `build/themes/${fileName}`;
      
      // Download the theme ZIP file
      const downloadResult = await ProcessManager.runShell(
        `curl -L -o "${downloadPath}" "${themeUrl}"`,
        { ignoreError: true }
      );
      
      if (!downloadResult.success) {
        throw new Error(`Failed to download theme: ${downloadResult.output}`);
      }
      
      // Extract the ZIP file to themes directory
      const extractResult = await ProcessManager.runShell(
        `cd build/themes && unzip -o "${fileName}" && rm "${fileName}"`,
        { ignoreError: true }
      );
      
      if (!extractResult.success) {
        throw new Error(`Failed to extract theme: ${extractResult.output}`);
      }
      
      Logger.success(`Theme downloaded and extracted: ${themeUrl}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Failed to download theme ${themeUrl}: ${errorMessage}`);
      throw error;
    }
  }

  private async downloadPlugin(pluginUrl: string): Promise<void> {
    Logger.log(`Downloading plugin: ${pluginUrl}`, '🔌');
    
    try {
      const fileName = `plugin-${Date.now()}.zip`;
      const downloadPath = `build/plugins/${fileName}`;
      
      // Download the plugin ZIP file
      const downloadResult = await ProcessManager.runShell(
        `curl -L -o "${downloadPath}" "${pluginUrl}"`,
        { ignoreError: true }
      );
      
      if (!downloadResult.success) {
        throw new Error(`Failed to download plugin: ${downloadResult.output}`);
      }
      
      // Extract the ZIP file to plugins directory
      const extractResult = await ProcessManager.runShell(
        `cd build/plugins && unzip -o "${fileName}" && rm "${fileName}"`,
        { ignoreError: true }
      );
      
      if (!extractResult.success) {
        throw new Error(`Failed to extract plugin: ${extractResult.output}`);
      }
      
      Logger.success(`Plugin downloaded and extracted: ${pluginUrl}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Failed to download plugin ${pluginUrl}: ${errorMessage}`);
      throw error;
    }
  }

  private async updateComposeForCustomImage(imageName: string): Promise<void> {
    Logger.log('Updating docker-compose.yml to use custom image...', '📝');
    
    try {
      const composeContent = await Deno.readTextFile('docker-compose.yml');
      const updatedContent = composeContent.replace(
        /image: mautic\/mautic:[^-]+-apache/g,
        `image: ${imageName}`
      );
      
      await Deno.writeTextFile('docker-compose.yml', updatedContent);
      Logger.success('docker-compose.yml updated for custom image');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to update docker-compose.yml: ${errorMessage}`);
    }
  }

  private async installThemesAndPluginsRuntime(): Promise<void> {
    Logger.log('Using runtime installation for themes and plugins...', '⚙️');
    
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
      
      // Run the actual installation with timeout using ProcessManager
      Logger.log('Starting Mautic installation...', '🚀');
      
      const siteUrl = this.config.domainName 
        ? `https://${this.config.domainName}` 
        : `http://${this.config.ipAddress}:${this.config.port}`;
      
      Logger.log(`Site URL: ${siteUrl}`, '🌐');
      Logger.log('Database: mautic_db', '🗄️');
      Logger.log(`Admin email: ${this.config.emailAddress}`, '👤');
      
      // Use timeout command to limit installation time
      const installResult = await ProcessManager.run([
        'timeout', '300', // 5 minutes timeout
        'docker', 'exec', 
        '--user', 'www-data',
        '--workdir', '/var/www/html',
        'mautic_web', 
        'php', './bin/console', 'mautic:install',
        siteUrl,
        '--admin_email=' + this.config.emailAddress,
        '--admin_password=' + this.config.mauticPassword,
        '--force',
        '--no-interaction',
        '-vvv'
      ], { timeout: 320000 }); // ProcessManager timeout slightly longer than shell timeout
      
      if (installResult.success) {
        Logger.success('✅ Mautic installation completed successfully');
        Logger.log(installResult.output, '📄');
      } else {
        Logger.error('❌ Mautic installation failed');
        Logger.log(installResult.output, '📄');
        throw new Error(`Installation failed: ${installResult.output}`);
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Mautic installation failed: ${errorMessage}`);
      throw new Error(`Mautic installation failed: ${errorMessage}`);
    }
  }

  /**
   * Clear Mautic cache using simple file removal
   */
  private async clearCache(context: string): Promise<void> {
    Logger.info(`🧹 Clearing cache ${context}...`);
    
    try {
      // Use simple rm command - much faster than PHP console commands
      // Clear both prod and dev cache directories to be safe
      await ProcessManager.run([
        'docker', 'exec', 'mautic_web', 
        'bash', '-c', 'rm -rf /var/www/html/var/cache/prod* /var/www/html/var/cache/dev* || true'
      ], { timeout: 30000 }); // 30 second timeout - should be very fast
      
      Logger.success(`✅ Cache cleared ${context}`);
    } catch (error) {
      // Cache clearing is not critical - log but don't fail deployment
      Logger.error(`⚠️ Cache clearing failed ${context} (non-critical): ${error}`);
    }
  }
}