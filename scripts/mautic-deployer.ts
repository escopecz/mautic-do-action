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
      
      // Fix media .htaccess files if they have incorrect configuration
      await this.fixMediaHtaccess();
      
      // Install themes and plugins if specified
      if (this.config.mauticThemes || this.config.mauticPlugins) {
        Logger.log('=== STARTING THEMES AND PLUGINS INSTALLATION ===', '🎯');
        Logger.log(`Themes configured: ${this.config.mauticThemes ? 'YES' : 'NO'}`, '🎨');
        Logger.log(`Plugins configured: ${this.config.mauticPlugins ? 'YES' : 'NO'}`, '🔌');
        
        if (this.config.mauticPlugins) {
          Logger.log(`Plugin URLs: ${this.config.mauticPlugins}`, '📋');
        }
        
        await this.installThemesAndPlugins();
        
        Logger.log('=== THEMES AND PLUGINS INSTALLATION COMPLETED ===', '🎯');
        // Clear cache after installing packages
        await this.clearCache('after installing themes/plugins');
      } else {
        Logger.log('No themes or plugins configured for installation', 'ℹ️');
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
  
  public async installThemesAndPlugins(): Promise<void> {
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
    // Always use runtime installation for better memory efficiency
    // Custom image building can cause memory issues on small VPS instances
    Logger.log('Using runtime installation approach for plugins/themes', '⚙️');
    return false;
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
      // Parse URL parameters if it's a GitHub URL
      let cleanUrl = pluginUrl;
      let directory = '';
      let token = '';
      
      if (pluginUrl.startsWith('https://github.com/') && pluginUrl.includes('?')) {
        try {
          const url = new URL(pluginUrl);
          cleanUrl = `${url.protocol}//${url.host}${url.pathname}`;
          directory = url.searchParams.get('directory') || '';
          token = url.searchParams.get('token') || '';
          
          // Convert GitHub archive URLs to API endpoints for private repositories
          if (token && cleanUrl.includes('/archive/')) {
            // Convert https://github.com/owner/repo/archive/refs/heads/branch.zip
            // to https://api.github.com/repos/owner/repo/zipball/branch
            const match = cleanUrl.match(/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/archive\/(?:refs\/heads\/)?(.+)\.zip/);
            if (match) {
              const [, owner, repo, branch] = match;
              cleanUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${branch}`;
              Logger.log(`Converted GitHub archive URL to API endpoint: ${cleanUrl}`, '🔄');
            }
          }
        } catch (error) {
          Logger.log(`Failed to parse URL parameters, using URL as-is: ${error}`, '⚠️');
        }
      }
      
      // Use URL-specific token if provided, otherwise fall back to global token
      const authToken = token || this.config.githubToken;
      
      const fileName = `plugin-${Date.now()}.zip`;
      const downloadPath = `build/plugins/${fileName}`;
      
      // Prepare download command with authentication if needed
      let downloadCommand = '';
      if (authToken && cleanUrl.includes('github.com')) {
        // Log sanitized URL for debugging (without token)
        Logger.log(`Downloading from GitHub with authentication: ${cleanUrl}`, '🔍');
        // Use curl with GitHub API endpoint and proper headers
        downloadCommand = `curl -L -o "${downloadPath}" -H "Authorization: Bearer ${authToken}" -H "Accept: application/vnd.github.v3+json" --connect-timeout 30 --max-time 60 --retry 2 "${cleanUrl}"`;
      } else {
        Logger.log(`Downloading from public URL: ${cleanUrl}`, '🔍');
        downloadCommand = `curl -L -o "${downloadPath}" --connect-timeout 30 --max-time 60 --retry 2 "${cleanUrl}"`;
      }
      
      // Download the plugin ZIP file
      const downloadResult = await ProcessManager.runShell(downloadCommand, { ignoreError: true });
      
      if (!downloadResult.success) {
        throw new Error(`Failed to download plugin: ${downloadResult.output}`);
      }
      
      // Validate ZIP file before extraction
      const validateResult = await ProcessManager.runShell(`file "${downloadPath}" | grep -q "Zip archive data"`, { ignoreError: true });
      
      if (!validateResult.success) {
        // Clean up invalid file
        await ProcessManager.runShell(`rm -f "${downloadPath}"`, { ignoreError: true });
        throw new Error('Downloaded file is not a valid ZIP archive');
      }
      
      // Extract the ZIP file to plugins directory
      let extractCommand = '';
      if (directory) {
        // For GitHub API zipballs, we need to handle the nested directory structure
        if (cleanUrl.includes('api.github.com')) {
          // GitHub API creates a zip with a subdirectory named after the commit
          extractCommand = `cd build/plugins && mkdir -p temp_extract "${directory}" && unzip -o "${fileName}" -d temp_extract && rm "${fileName}" && cd temp_extract && subdir=$(ls -1 | head -1) && if [ -d "$subdir" ]; then cp -r "$subdir"/* "../${directory}/"; fi && cd .. && rm -rf temp_extract`;
        } else {
          extractCommand = `cd build/plugins && mkdir -p "${directory}" && unzip -o "${fileName}" -d "${directory}" && rm "${fileName}"`;
        }
      } else {
        extractCommand = `cd build/plugins && unzip -o "${fileName}" && rm "${fileName}"`;
      }
      
      const extractResult = await ProcessManager.runShell(extractCommand, { ignoreError: true });
      
      if (!extractResult.success) {
        throw new Error(`Failed to extract plugin: ${extractResult.output}`);
      }
      
      const displayName = directory ? `${pluginUrl} → ${directory}` : pluginUrl;
      Logger.success(`Plugin downloaded and extracted: ${displayName}`);
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
    Logger.log('=== STARTING RUNTIME INSTALLATION ===', '⚙️');
    Logger.log('Using runtime installation for themes and plugins (memory-efficient approach)...', '⚙️');
    
    // Install themes
    if (this.config.mauticThemes) {
      Logger.log('Installing themes via runtime approach...', '🎨');
      const themes = this.config.mauticThemes.split('\n').map(t => t.trim()).filter(Boolean);
      Logger.log(`Found ${themes.length} themes to install`, '📊');
      let themeSuccessCount = 0;
      let themeFailureCount = 0;
      
      for (const theme of themes) {
        try {
          Logger.log(`Processing theme: ${theme}`, '🎨');
          await this.installTheme(theme);
          themeSuccessCount++;
          Logger.log(`✅ Theme ${theme} installed successfully`, '✅');
        } catch (error) {
          themeFailureCount++;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          Logger.log(`⚠️ Theme installation failed for ${theme}: ${errorMessage}`, '⚠️');
          Logger.log('Continuing with remaining themes...', '➡️');
        }
      }
      
      Logger.log(`Theme installation summary: ${themeSuccessCount} successful, ${themeFailureCount} failed`, '📊');
    }

    // Install plugins
    if (this.config.mauticPlugins) {
      Logger.log('=== STARTING PLUGIN INSTALLATION ===', '🔌');
      Logger.log('Installing plugins via runtime approach...', '🔌');
      const plugins = this.config.mauticPlugins.split('\n').map(p => p.trim()).filter(Boolean);
      Logger.log(`Found ${plugins.length} plugins to install`, '📊');
      let pluginSuccessCount = 0;
      let pluginFailureCount = 0;
      
      for (const plugin of plugins) {
        try {
          Logger.log(`Processing plugin: ${plugin}`, '🔌');
          Logger.log(`Plugin URL: ${plugin}`, '🔗');
          await this.installPlugin(plugin);
          pluginSuccessCount++;
          Logger.log(`✅ Plugin ${plugin} installed successfully`, '✅');
        } catch (error) {
          pluginFailureCount++;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          Logger.log(`⚠️ Plugin installation failed for ${plugin}: ${errorMessage}`, '⚠️');
          Logger.log('Continuing with remaining plugins...', '➡️');
        }
      }
      
      Logger.log(`Plugin installation summary: ${pluginSuccessCount} successful, ${pluginFailureCount} failed`, '📊');
    }
    
    Logger.log('=== COMPLETED RUNTIME INSTALLATION ===', '✅');
    Logger.success('Runtime installation of themes and plugins completed');
  }
  
  private async installTheme(themeUrl: string): Promise<void> {
    Logger.log(`Installing theme: ${themeUrl}`, '🎨');
    
    try {
      // Parse URL parameters if it's a GitHub URL
      let cleanUrl = themeUrl;
      let directory = '';
      let token = '';
      
      if (themeUrl.startsWith('https://github.com/') && themeUrl.includes('?')) {
        try {
          const url = new URL(themeUrl);
          cleanUrl = `${url.protocol}//${url.host}${url.pathname}`;
          directory = url.searchParams.get('directory') || '';
          token = url.searchParams.get('token') || '';
          
          // Convert GitHub archive URLs to API endpoints for private repositories
          if (token && cleanUrl.includes('/archive/')) {
            // Convert https://github.com/owner/repo/archive/refs/heads/branch.zip
            // to https://api.github.com/repos/owner/repo/zipball/branch
            const match = cleanUrl.match(/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/archive\/(?:refs\/heads\/)?(.+)\.zip/);
            if (match) {
              const [, owner, repo, branch] = match;
              cleanUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${branch}`;
              Logger.log(`Converted GitHub archive URL to API endpoint: ${cleanUrl}`, '🔄');
            }
          }
        } catch (error) {
          Logger.log(`Failed to parse URL parameters, using URL as-is: ${error}`, '⚠️');
        }
      }
      
      // Use URL-specific token if provided, otherwise fall back to global token
      const authToken = token || this.config.githubToken;

      // Handle upgrades: remove existing theme directory if it exists
      if (directory) {
        Logger.log(`🔄 Checking for existing theme: ${directory}`, '🔄');
        const checkExisting = await ProcessManager.runShell(`docker exec mautic_web bash -c 'test -d /var/www/html/docroot/themes/${directory}'`, { ignoreError: true });
        
        if (checkExisting.success) {
          Logger.log(`🗑️ Removing existing theme directory: ${directory}`, '🗑️');
          const removeResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'rm -rf /var/www/html/docroot/themes/${directory}'`, { ignoreError: true });
          
          if (!removeResult.success) {
            Logger.log(`⚠️ Warning: Could not remove existing theme directory: ${removeResult.output}`, '⚠️');
          } else {
            Logger.log(`✅ Existing theme directory removed successfully`, '✅');
          }
        } else {
          Logger.log(`ℹ️ No existing theme directory found (fresh installation)`, 'ℹ️');
        }
      }
      
      // Prepare curl command
      let curlCommand = '';
      if (authToken && cleanUrl.includes('github.com')) {
        Logger.log(`Installing theme with GitHub authentication: ${cleanUrl}`, '🔍');
        // Use GitHub API endpoint with proper headers
        curlCommand = `curl -L -o theme.zip -H "Authorization: Bearer ${authToken}" -H "Accept: application/vnd.github.v3+json" --connect-timeout 30 --max-time 60 --retry 2 "${cleanUrl}"`;
      } else {
        Logger.log(`Installing theme from public URL: ${cleanUrl}`, '🔍');
        curlCommand = `curl -L -o theme.zip --connect-timeout 30 --max-time 60 --retry 2 "${cleanUrl}"`;
      }
      
      // Extract to specified directory or default behavior
      let extractCommand = '';
      if (directory) {
        // For GitHub API zipballs, we need to handle the nested directory structure
        if (cleanUrl.includes('api.github.com')) {
          // GitHub API creates a zip with a subdirectory named after the commit
          extractCommand = `mkdir -p temp_extract "${directory}" && unzip -o theme.zip -d temp_extract && rm theme.zip && cd temp_extract && subdir=$(ls -1 | head -1) && if [ -d "$subdir" ]; then cp -r "$subdir"/* "../${directory}/"; fi && cd .. && rm -rf temp_extract`;
        } else {
          extractCommand = `mkdir -p "${directory}" && unzip -o theme.zip -d "${directory}" && rm theme.zip`;
        }
      } else {
        extractCommand = `unzip -o theme.zip && rm theme.zip`;
      }
      
      await ProcessManager.runShell(`
        docker exec mautic_web bash -c "cd /var/www/html/docroot/themes && ${curlCommand} && ${extractCommand}"
      `, { ignoreError: true });

      // Fix ownership and permissions for the theme directory if specified
      if (directory) {
        Logger.log(`🔒 Setting correct ownership and permissions for theme ${directory}...`, '🔒');
        const chownResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'chown -R www-data:www-data /var/www/html/docroot/themes/${directory} && chmod -R 755 /var/www/html/docroot/themes/${directory}'`, { ignoreError: true });
        
        if (chownResult.success) {
          Logger.log(`✅ Theme ownership and permissions set correctly`, '✅');
        } else {
          Logger.log(`⚠️ Warning: Could not set theme ownership/permissions: ${chownResult.output}`, '⚠️');
        }
      }

      // Clear cache after theme installation
      Logger.log(`🧹 Clearing cache after theme installation...`, '🧹');
      const cacheResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html && rm -rf var/cache/prod/*'`, { ignoreError: true });
      
      if (!cacheResult.success) {
        Logger.log(`⚠️ Warning: Cache clear failed: ${cacheResult.output}`, '⚠️');
      } else {
        Logger.log(`✅ Cache cleared successfully`, '✅');
      }
      
      const displayName = directory ? `${themeUrl} → ${directory}` : themeUrl;
      Logger.success(`Theme installed: ${displayName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`❌ Failed to install theme ${themeUrl}: ${errorMessage}`);
      // Re-throw the error to fail the build as requested
      throw error;
    }
  }
  
  private async installPlugin(pluginUrl: string): Promise<void> {
    Logger.log(`Installing plugin: ${pluginUrl}`, '🔌');
    
    try {
      // Parse URL parameters if it's a GitHub URL
      let cleanUrl = pluginUrl;
      let directory = '';
      let token = '';
      
      if (pluginUrl.startsWith('https://github.com/') && pluginUrl.includes('?')) {
        try {
          const url = new URL(pluginUrl);
          cleanUrl = `${url.protocol}//${url.host}${url.pathname}`;
          directory = url.searchParams.get('directory') || '';
          token = url.searchParams.get('token') || '';
          
          // Convert GitHub archive URLs to API endpoints for private repositories
          if (token && cleanUrl.includes('/archive/')) {
            // Convert https://github.com/owner/repo/archive/refs/heads/branch.zip
            // to https://api.github.com/repos/owner/repo/zipball/branch
            const match = cleanUrl.match(/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/archive\/(?:refs\/heads\/)?(.+)\.zip/);
            if (match) {
              const [, owner, repo, branch] = match;
              cleanUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${branch}`;
              Logger.log(`Converted GitHub archive URL to API endpoint: ${cleanUrl}`, '🔄');
            }
          }
        } catch (error) {
          Logger.log(`Failed to parse URL parameters, using URL as-is: ${error}`, '⚠️');
        }
      }
      
      // Use URL-specific token if provided, otherwise fall back to global token
      const authToken = token || this.config.githubToken;

      // Clean up any leftover temp directories from previous failed extractions
      await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html/docroot/plugins && rm -rf temp_extract'`, { ignoreError: true });

      // Handle upgrades: remove existing plugin directory if it exists
      if (directory) {
        Logger.log(`🔄 Checking for existing plugin: ${directory}`, '🔄');
        const checkExisting = await ProcessManager.runShell(`docker exec mautic_web bash -c 'test -d /var/www/html/docroot/plugins/${directory}'`, { ignoreError: true });
        
        if (checkExisting.success) {
          Logger.log(`🗑️ Removing existing plugin directory: ${directory}`, '🗑️');
          const removeResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'rm -rf /var/www/html/docroot/plugins/${directory}'`, { ignoreError: true });
          
          if (!removeResult.success) {
            Logger.log(`⚠️ Warning: Could not remove existing plugin directory: ${removeResult.output}`, '⚠️');
          } else {
            Logger.log(`✅ Existing plugin directory removed successfully`, '✅');
          }
        } else {
          Logger.log(`ℹ️ No existing plugin directory found (fresh installation)`, 'ℹ️');
        }
      }
      
      // Check if required tools are available in container
      const toolsCheck = await ProcessManager.runShell(`docker exec mautic_web bash -c 'which curl && which unzip && which file'`, { ignoreError: true });
      if (!toolsCheck.success) {
        Logger.log(`⚠️ Warning: Some required tools may be missing in container: ${toolsCheck.output}`, '⚠️');
      } else {
        Logger.log(`✅ Required tools available in container`, '✅');
      }
      
      // Download the plugin using a more reliable approach
      let downloadCommand;
      if (authToken && cleanUrl.includes('github.com')) {
        // For GitHub API with authentication, use curl with proper headers
        downloadCommand = `docker exec mautic_web bash -c 'cd /var/www/html/docroot/plugins && curl -L -o plugin.zip -H "Authorization: Bearer ${authToken}" -H "Accept: application/vnd.github.v3+json" --connect-timeout 30 --max-time 60 --retry 2 "${cleanUrl}"'`;
      } else {
        downloadCommand = `docker exec mautic_web bash -c 'cd /var/www/html/docroot/plugins && curl -L -o plugin.zip --connect-timeout 30 --max-time 60 --retry 2 "${cleanUrl}"'`;
      }
      
      const downloadResult = await ProcessManager.runShell(downloadCommand, { ignoreError: true });

      if (!downloadResult.success) {
        Logger.log(`❌ Download failed with exit code. Full command output:`, '❌');
        Logger.log(downloadResult.output, '📄');
        Logger.log(`Command that failed: ${downloadCommand.replace(/Bearer [^"'\s]*/g, 'Bearer ***')}`, '🔍');
        throw new Error(`Failed to download plugin: ${downloadResult.output}`);
      } else {
        Logger.log(`✅ Download completed successfully`, '✅');
      }
      
      // Validate ZIP file before extraction
      const validateResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html/docroot/plugins && file plugin.zip'`, { ignoreError: true });
      
      if (!validateResult.success) {
        Logger.log(`⚠️ Could not validate ZIP file: ${validateResult.output}`, '⚠️');
      } else {
        Logger.log(`📁 ZIP file info: ${validateResult.output}`, '📁');
        if (!validateResult.output.includes('Zip archive data')) {
          // Clean up invalid file
          await ProcessManager.runShell('docker exec mautic_web bash -c "cd /var/www/html/docroot/plugins && rm -f plugin.zip"', { ignoreError: true });
          throw new Error('Downloaded file is not a valid ZIP archive');
        }
      }
      
      // Extract to specified directory or default behavior
      let extractResult;
      if (directory) {
        // For GitHub API zipballs, we need to handle the nested directory structure
        if (cleanUrl.includes('api.github.com')) {
          // GitHub API creates a zip with a subdirectory named after the commit
          Logger.log(`🔍 Extracting GitHub API zipball to ${directory}...`, '🔍');
          
          // First, let's see what's in the zip
          const zipContents = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html/docroot/plugins && unzip -l plugin.zip'`, { ignoreError: true });
          if (zipContents.success) {
            Logger.log(`📋 ZIP file contents:`, '📋');
            Logger.log(zipContents.output, '📄');
          }
          
          // Extract to temp, find the subdirectory, then move contents to target directory
          const extractCmd = `cd /var/www/html/docroot/plugins && \\
echo "=== STARTING EXTRACTION PROCESS ===" && \\
mkdir -p temp_extract "${directory}" && \\
echo "Created directories temp_extract and ${directory}" && \\
unzip -o plugin.zip -d temp_extract && \\
echo "Extracted plugin.zip to temp_extract" && \\
rm plugin.zip && \\
echo "Removed plugin.zip" && \\
echo "Contents of temp_extract:" && \\
ls -la temp_extract && \\
cd temp_extract && \\
subdir=\$(ls -1 | head -1) && \\
echo "Found subdirectory: \$subdir" && \\
if [ -d "\$subdir" ]; then \\
  echo "Subdirectory \$subdir exists, checking its contents:" && \\
  ls -la "\$subdir" && \\
  echo "Copying ALL contents from \$subdir to ../${directory}/" && \\
  (cd "\$subdir" && cp -r . "../../${directory}/") && \\
  echo "Copy operation completed" && \\
  echo "Checking target directory after copy:" && \\
  ls -la "../${directory}/" && \\
  echo "File count in target:" && \\
  find "../${directory}/" -type f | wc -l; \\
else \\
  echo "ERROR: No subdirectory found or not a directory"; \\
  echo "Available items in temp_extract:"; \\
  ls -la; \\
fi && \\
cd .. && \\
echo "Cleaning up temp_extract" && \\
rm -rf temp_extract && \\
echo "=== EXTRACTION PROCESS COMPLETE ==="`;
          extractResult = await ProcessManager.runShell(`docker exec mautic_web bash -c '${extractCmd}'`, { ignoreError: true });
          
          // Log what happened during extraction
          Logger.log(`📋 EXTRACTION OUTPUT:`, '📋');
          Logger.log(extractResult.output, '📄');
          
          if (!extractResult.success) {
            Logger.log(`❌ GitHub API zipball extraction failed with exit code: ${extractResult.exitCode}`, '❌');
            // Check if temp_extract still exists and what's in it
            const tempCheck = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html/docroot/plugins && if [ -d temp_extract ]; then echo "temp_extract still exists:"; ls -la temp_extract; else echo "temp_extract does not exist"; fi'`, { ignoreError: true });
            if (tempCheck.success) {
              Logger.log(`📋 temp_extract status after failed extraction:`, '📋');
              Logger.log(tempCheck.output, '📄');
            }
          } else {
            Logger.log(`✅ GitHub API zipball extraction command completed successfully`, '✅');
            
            // CRITICAL: Check if files actually made it to the target directory
            const finalCheck = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html/docroot/plugins && echo "=== FINAL VERIFICATION ===" && ls -la ${directory}/ && echo "=== FILE COUNT ===" && find ${directory} -type f | wc -l && echo "=== SAMPLE FILES ===" && find ${directory} -type f | head -5'`, { ignoreError: true });
            if (finalCheck.success) {
              Logger.log(`📋 FINAL EXTRACTION VERIFICATION:`, '📋');
              Logger.log(finalCheck.output, '📄');
            }
          }
        } else {
          extractResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html/docroot/plugins && mkdir -p "${directory}" && unzip -o plugin.zip -d "${directory}" && rm plugin.zip'`, { ignoreError: true });
        }
      } else {
        extractResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html/docroot/plugins && unzip -o plugin.zip && rm plugin.zip'`, { ignoreError: true });
      }
      
      if (!extractResult.success) {
        Logger.log(`❌ Extraction failed: ${extractResult.output}`, '❌');
        throw new Error(`Failed to extract plugin: ${extractResult.output}`);
      } else {
        Logger.log(`✅ Extraction completed successfully`, '✅');
        
        // Verify what was installed
        const verifyResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html/docroot/plugins && ls -la'`, { ignoreError: true });
        if (verifyResult.success) {
          Logger.log(`📋 Plugin directory contents after installation:`, '📋');
          Logger.log(verifyResult.output, '📄');
        }

        // Show detailed contents of the specific plugin directory
        if (directory) {
          const detailCheck = await ProcessManager.runShell(`docker exec mautic_web bash -c 'ls -la /var/www/html/docroot/plugins/${directory}/ && echo "File count:" && find /var/www/html/docroot/plugins/${directory} -type f | wc -l'`, { ignoreError: true });
          if (detailCheck.success) {
            Logger.log(`📋 Detailed contents of ${directory} directory:`, '📋');
            Logger.log(detailCheck.output, '📄');
          }
        }

        // Verify that the main plugin file exists if we have a directory name
        if (directory) {
          const pluginFileCheck = await ProcessManager.runShell(`docker exec mautic_web bash -c 'test -f /var/www/html/docroot/plugins/${directory}/${directory}.php'`, { ignoreError: true });
          
          if (pluginFileCheck.success) {
            Logger.log(`✅ Main plugin file ${directory}.php found in correct location`, '✅');
          } else {
            Logger.log(`⚠️ Warning: Main plugin file ${directory}.php not found, checking directory contents...`, '⚠️');
            const dirContents = await ProcessManager.runShell(`docker exec mautic_web bash -c 'ls -la /var/www/html/docroot/plugins/${directory}/'`, { ignoreError: true });
            if (dirContents.success) {
              Logger.log(`📋 Directory contents for ${directory}:`, '📋');
              Logger.log(dirContents.output, '📄');
            }
          }

          // Fix ownership and permissions for the plugin directory
          Logger.log(`🔒 Setting correct ownership and permissions for ${directory}...`, '🔒');
          const chownResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'chown -R www-data:www-data /var/www/html/docroot/plugins/${directory} && chmod -R 755 /var/www/html/docroot/plugins/${directory}'`, { ignoreError: true });
          
          if (chownResult.success) {
            Logger.log(`✅ Ownership and permissions set correctly`, '✅');
          } else {
            Logger.log(`⚠️ Warning: Could not set ownership/permissions: ${chownResult.output}`, '⚠️');
          }

          // Verify final ownership and permissions
          const permCheck = await ProcessManager.runShell(`docker exec mautic_web bash -c 'ls -la /var/www/html/docroot/plugins/${directory}/'`, { ignoreError: true });
          if (permCheck.success) {
            Logger.log(`📋 Final ownership and permissions for ${directory}:`, '📋');
            Logger.log(permCheck.output, '📄');
          }
        }

        // Clear cache first to ensure autoloading works
        Logger.log(`🧹 Clearing cache before plugin registration...`, '🧹');
        const preCacheResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html && rm -rf var/cache/prod/* var/cache/dev/*'`, { ignoreError: true });
        
        if (!preCacheResult.success) {
          Logger.log(`⚠️ Warning: Pre-cache clear failed: ${preCacheResult.output}`, '⚠️');
        } else {
          Logger.log(`✅ Pre-cache cleared successfully`, '✅');
        }

        // Run Mautic plugin installation command
        Logger.log(`🔧 Running Mautic plugin installation command...`, '🔧');
        const consoleResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html && php bin/console mautic:plugins:install --force'`, { ignoreError: true });
        
        if (!consoleResult.success) {
          Logger.log(`⚠️ Warning: Plugin console command failed: ${consoleResult.output}`, '⚠️');
          // Try alternative approach: just reload plugins
          Logger.log(`🔄 Trying alternative plugin reload...`, '🔄');
          const reloadResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html && php bin/console mautic:plugins:reload'`, { ignoreError: true });
          if (reloadResult.success) {
            Logger.log(`✅ Plugin reload successful`, '✅');
            Logger.log(reloadResult.output, '📄');
          } else {
            Logger.log(`⚠️ Plugin reload also failed: ${reloadResult.output}`, '⚠️');
          }
        } else {
          Logger.log(`✅ Plugin registered with Mautic successfully`, '✅');
          Logger.log(consoleResult.output, '📄');
        }

        // Clear cache after plugin installation
        Logger.log(`🧹 Clearing cache after plugin installation...`, '🧹');
        const cacheResult = await ProcessManager.runShell(`docker exec mautic_web bash -c 'cd /var/www/html && rm -rf var/cache/prod/* var/cache/dev/*'`, { ignoreError: true });
        
        if (!cacheResult.success) {
          Logger.log(`⚠️ Warning: Cache clear failed: ${cacheResult.output}`, '⚠️');
        } else {
          Logger.log(`✅ Cache cleared successfully`, '✅');
        }
      }
      
      const displayName = directory ? `${pluginUrl} → ${directory}` : pluginUrl;
      Logger.success(`Plugin installed: ${displayName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`❌ Failed to install plugin ${pluginUrl}: ${errorMessage}`);
      // Re-throw the error to fail the build as requested
      throw error;
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
   * Fix .htaccess files in media directories to use official Mautic configuration
   */
  private async fixMediaHtaccess(): Promise<void> {
    Logger.log('� Checking and fixing media .htaccess files...', '�');
    
    try {
      // Use the official Mautic 6.x .htaccess for media directories
      const officialMediaHtaccess = `<IfModule mod_authz_core.c>
    Require all granted
</IfModule>
<IfModule !mod_authz_core.c>
    Order allow,deny
    Allow from all
</IfModule>`;

      // Check if images .htaccess needs fixing
      const checkImagesHtaccess = await ProcessManager.runShell(
        `docker exec mautic_web bash -c 'cat /var/www/html/docroot/media/images/.htaccess 2>/dev/null'`,
        { ignoreError: true }
      );
      
      if (checkImagesHtaccess.success && checkImagesHtaccess.output.includes('deny from all')) {
        Logger.log(`⚠️ Found incorrect .htaccess in images directory, fixing...`, '⚠️');
        
        const fixImagesResult = await ProcessManager.runShell(
          `docker exec mautic_web bash -c 'cat > /var/www/html/docroot/media/images/.htaccess << "EOF"
${officialMediaHtaccess}
EOF'`,
          { ignoreError: true }
        );
        
        if (fixImagesResult.success) {
          Logger.log(`✅ Fixed .htaccess for images directory`, '✅');
        } else {
          Logger.log(`⚠️ Warning: Could not fix images .htaccess: ${fixImagesResult.output}`, '⚠️');
        }
      } else {
        Logger.log(`✅ Images .htaccess appears to be correct`, '✅');
      }

      // Check if files .htaccess needs fixing
      const checkFilesHtaccess = await ProcessManager.runShell(
        `docker exec mautic_web bash -c 'cat /var/www/html/docroot/media/files/.htaccess 2>/dev/null'`,
        { ignoreError: true }
      );
      
      if (checkFilesHtaccess.success && checkFilesHtaccess.output.includes('deny from all')) {
        Logger.log(`⚠️ Found incorrect .htaccess in files directory, fixing...`, '⚠️');
        
        const fixFilesResult = await ProcessManager.runShell(
          `docker exec mautic_web bash -c 'cat > /var/www/html/docroot/media/files/.htaccess << "EOF"
${officialMediaHtaccess}
EOF'`,
          { ignoreError: true }
        );
        
        if (fixFilesResult.success) {
          Logger.log(`✅ Fixed .htaccess for files directory`, '✅');
        } else {
          Logger.log(`⚠️ Warning: Could not fix files .htaccess: ${fixFilesResult.output}`, '⚠️');
        }
      } else {
        Logger.log(`✅ Files .htaccess appears to be correct`, '✅');
      }
      
      Logger.success('✅ Media .htaccess check completed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`⚠️ Media .htaccess check failed: ${errorMessage}`);
      // Don't throw error as this is not critical for basic functionality
    }
  }

  /**
   * Clear Mautic cache using simple file removal
   */
  public async clearCache(context: string): Promise<void> {
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